/**
 * POST / OPTIONS /api/agent-mcp/console/bootstrap-su
 *
 * Bootstraps a tracked superuser engineer session for one of the three
 * `*-su` wrappers (claude-su / omp-su / codex-su). Called by the
 * plan-tracked launcher after the user picks a harness + plan; the
 * launcher cd's to `cwd`, exports `envelopeEnv`, and exec's `wrapperBin`.
 *
 * Per `psu-wrappers-and-plan-tracked-launch-2026-05-30` (P-006), pivoted
 * onto the shipped `*-su` wrappers + reconciled against the data model:
 *   - the session is an `adv_sessions` row (NOT a plan_run/spawn — those
 *     are the autonomous-execution surface). plan_slug set → plan-bound;
 *     null → a "No plan" row (D-005). Both appear in /adv Sessions.
 *   - the `*-su` wrappers already inject the playbook + skip-permissions
 *     + MCP auth (codex-su via a dedicated CODEX_HOME), so this returns
 *     only WHICH wrapper to exec + the tracking env — no cliFlags, no
 *     token handling.
 *
 * Principal-gated; CORS-open (operator binds loopback-only). `auth:
 * 'public'` — requirePrincipal() inline, mirroring console-launch.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId, isKnownWorkspace, readRegistry } from '../../../workspace-registry';
import { buildConsoleEnvelope } from '../../../console-launcher';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
// WI-42439: the single source for which `--account=` spellings bypass the gateway.
import { isGatewayFreeAccount } from '../../../agent-config-constants';
import { normalizeSuContextSize } from '../../../su-context-size.mjs';
import {
  NATIVE_SESSION_ID_RE,
  adoptStartingTerminalLaunch,
  endedRecordedOwnerIds,
  acquireAdvSessionResume,
  finalizeAdvSessionResume,
  isAdvSessionLocalLivenessEvidence,
  markAdvSessionEnded,
  parseKilledBySignalReport,
  claimAdvSessionResume,
  releaseAdvSessionResume,
  reanchorAdvSessionNativeId,
  reanchorAdvSessionNativeIdByOwner,
  recordAdvSession,
  recordSuLaunchSpec,
  repairStaleAdvSessionTerminalMarkers,
} from '../../../adv-sessions';
// stale-prompt-render-in-live-sessions-2026-08-02 P-002/D-001: the prompt-assembly
// steps this route shares with the carry-respawn persona refresh. Both paths must
// call THESE — a second, drifting assembly is the failure mode the fix introduces.
import {
  applySuPromptOverlays,
  resolveSuInstructionRuntime,
  resolveSuPlanContext,
  type SuLaunchSpecRecord,
} from '../../../su-persona-render';
import { getOrgPg } from '@papercusp/db-org';
import {
  classifyPrePinnedOwnerRows,
  describePrePinnedConflicts,
  mapPrePinnedOwnerSessionState,
} from './pre-pinned-owner-rows';
import { resolveSessionStates } from '../../../agent-tools/coordination/liveness-oracle';
import { isSuAgent, type SuAgent } from '../../../su-agents';
import { launchContextDir, launchContextPathFor } from '../../../su-launch-context';
import { buildLaunchSpec, compileLaunchSpecificationArtifact, provisionLaunchIdentityResources, resolveLaunchIdentityModelDefault } from '../../../role-launch-spec';
import { SU_TIER_ROLES, isSuTierRole, resolveSuRoleAddendum } from '../../../su-role-addendum';
import {
  blockingInstructionConflicts,
  buildInstructionPrecedenceTrace,
  lintInstructionText,
  type InstructionLintReport,
  type InstructionRuntimeContext,
} from '../../../instruction-lint';
import {
  deriveLaunchPromptText,
  kickoffGuardProfileForAgent,
  type RemoteSeatSummary,
} from '../../../agent-tools/plans/launch-prompt';
import {
  claimAgentLaunch,
  normalizeLaunchMode,
  recordAgentLaunchResult,
  releaseAgentLaunchClaim,
  type LaunchMode,
} from '../../../agent-launch-core';
import { resolveRemoteSeatInventory } from '../../../agent-tools/plans/remote-seat-inventory';
import { writeSuCodexHome } from '../../../role-codex-home';
// EI-11366: the real liveness check wired into writeSuCodexHome's identity-
// split collision guard — is there a LIVE psu-pty host process for a sid that
// previously owned the CODEX_HOME directory we're about to rebuild?
import { findLiveHost } from '../../../events/await/psu-pty-discovery';
import { writeInteractiveClaudeConfig } from '../../../interactive-claude-config';
import { resolveSuLaunchCwd, type SuLaunchCwdPolicy } from '../../../su-launch-cwd';
import {
  materializeCodexPrompts,
  materializeWorkspacePrompts,
  materializeHarnessPrompts,
} from '../../../saved-prompts-materialize';
import { emitCodexSlashToolPrompts } from '../../../slash-tool-prompts-codex';
import { resolveInstallPaths } from '../../../desktop-install/papercusp-files';
import { readSuperuserToken } from '../../../superuser-token';
import { homedir } from 'node:os';
import {
  accountProviderForInteractiveBackend,
  backendFeatureGuard,
  type BackendAccountProvider,
} from '../../../backend-feature-capabilities';
import { SESSION_PORT_PROTOCOL_VERSION, SESSION_PORT_TRANSFORM_VERSION, type SessionPortContractSummary } from '../../../session-port/types';
import { recordSessionPortTelemetry } from '../../../session-port/telemetry';
import { readOmpModelCatalog, type OmpModelCatalogEntry } from '../../../omp-config';
import { bindLiveAgentSessionTasksToNativeSession } from '../../../task-manager/store';
import { resolveCodexModel, resolveCodexModelSelection } from '../../../model-context-budget.mjs';
import { requestSessionIdentityActivation } from '../../../agent-tools/coordination/control-anchor';
import type { ModeRow } from '../../../modes/store';

// Exported for the sibling launcher-facing routes split out of this file (the
// persona refresh) — one copy of the CORS/principal boilerplate, not two.
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization',
};

export function jsonRes(body: unknown, init?: number | ResponseInit): Response {
  const r = Response.json(body, typeof init === 'number' ? { status: init } : init);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

export async function gatePrincipal(headers: Headers): Promise<Response | null> {
  try {
    await requirePrincipal(headers);
    return null;
  } catch (err) {
    if (err instanceof PrincipalCheckError) {
      return jsonRes({ status: 'error', error: err.reason }, err.status);
    }
    throw err;
  }
}

/**
 * Join a pre-fork headless task row to the native session identity bootstrap
 * learned inside the child. This is intentionally best-effort: task-manager
 * attribution/reaping must heal when it can, but a ledger outage must never
 * turn an otherwise valid agent launch or carry-respawn into a boot failure.
 */
export async function bindKnownAgentSessionTasks(input: {
  workspaceId: string;
  coordOwnerId: string;
  sessionId: string | null;
  source: 'bootstrap' | 'session-port' | 'respawn';
}): Promise<string[]> {
  if (!input.sessionId) return [];
  try {
    return await bindLiveAgentSessionTasksToNativeSession({
      workspaceId: input.workspaceId,
      coordOwnerId: input.coordOwnerId,
      sessionId: input.sessionId,
    });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    console.warn(
      `[bootstrap-su] ${input.source} task/session bind failed for ${input.coordOwnerId.slice(0, 120)}: ${detail}`,
    );
    return [];
  }
}

export interface BootstrapSuResult {
  status: 'ok';
  /** True when this response was replayed from the launch idempotency ledger. */
  bootstrapDeduped?: boolean;
  /** adv_sessions row id; null if the insert failed (best-effort). */
  sessionId: number | null;
  /** The agent's NATIVE session id the launcher must force on the CLI so the
   *  session is resumable + recognizable by id. claude → a forced UUID
   *  (`claude --session-id`); omp/codex → null (they don't take a forced id). */
  nativeSessionId: string | null;
  agent: SuAgent;
  /** Effective server-selected model, after identity defaults and launch overrides. */
  model?: string | null;
  modelSource?: 'explicit' | 'inherited' | 'configured-default' | null;
  /** Workspace the harness + session belong to. */
  workspaceId: string;
  /** Working directory the launcher should exec the agent in. */
  cwd: string;
  harnessSlug: string | null;
  planSlug: string | null;
  /**
   * File holding the engineer playbook + per-launch scope/plan addendum —
   * the launcher feeds it as the system prompt. claude/omp: a launch-context
   * `.md` (--append-system-prompt[-file]). codex: the CODEX_HOME AGENTS.md.
   */
  promptFile: string;
  /** Bounded lint of the compiled instructions. Conflicts/stale rules are
   * visible to launchers and diagnostics instead of silently reaching agents. */
  instructionLint?: InstructionLintReport;
  /** Exact P-038 artifact/state revisions materialized for this launch. */
  specificationRevision: string;
  stateRevision: string;
  compositionSource: 'blueprint' | 'compatibility';
  /**
   * Per-session CODEX_HOME for a codex su session (AGENTS.md = playbook,
   * config.toml = superuser MCP, settings.json = lock hooks, auth symlink).
   * null for claude/omp (their MCP + hooks are user-level). Also surfaced in
   * `envelopeEnv.CODEX_HOME`.
   */
  codexHome: string | null;
  /**
   * The omp coordination extension path (`~/.papercusp/papercusp-coord.ts`)
   * the launcher loads via `-e` for lock enforcement, or null if not
   * installed. Ignored for claude (hooks are user-level) + codex (home).
   */
  coordExtPath: string | null;
  /**
   * Env the launcher exports into the CHILD process (the raw CLI). Carries
   * the MCP/context vars + PAPERCUSP_AGENT + PAPERCUSP_SID (per-session
   * coord/lock owner) + PAPERCUSP_ADV_SESSION_ID + CODEX_HOME (codex) +
   * CLAUDE_CONFIG_DIR (claude — the per-session transcript-isolated config dir,
   * EI-155). No secrets — the superuser bearer is read from the 0600 token file
   * by the launcher, never sent over HTTP.
   */
  envelopeEnv: Record<string, string>;
  /**
   * psu-account-chooser P-002: a human-readable note about the `--account` request
   * after successful resolution — default, auto, or a confirmed pin. An unavailable
   * explicit nondefault route is returned as an HTTP error instead. null when no
   * account was requested.
   */
  accountNotice?: string | null;
  /**
   * named-su-agent-fleets P-006: a human-readable note about the chosen fleet —
   * "leading fleet X (Name)." for a freshly-created fleet, "joined fleet X as
   * member." for an existing one, or the fail-soft reason it was skipped. null when
   * no fleet was chosen. The launcher prints it so the membership is never silent.
   */
  fleetNotice?: string | null;
  /**
   * WI-1408 (fleet-join-startup-assertion): the resolved fleet slug/role, or null when
   * no fleet was requested. When a fleet WAS requested (`--fleet`/`--fleet-name`), this
   * route never returns `status: 'ok'` with a null `fleetSlug` — resolution failure is a
   * hard error (see the `fleetRequested` guard above) — so a caller (e.g. the launcher,
   * or a test) can assert `!body.fleet || result.fleetSlug != null` and it will hold.
   */
  fleetSlug?: string | null;
  fleetRole?: string | null;
  /**
   * improve-fleet-launch-autokickoff (EI-5503): the FIRST USER TURN a plan-bound
   * launch should submit so the agent immediately starts working the plan instead
   * of orienting once and parking idle. Present only when a plan is bound (else
   * null). The canonical kickoff text (deriveLaunchPromptText — the same string
   * headless plans:launch seeds), so it never drifts. The launcher GATES delivery
   * to scripted launches (--no-picker + --plan, unless --no-kickoff) so an
   * interactive human picker launch still opens at an empty prompt.
   */
  kickoffPrompt?: string | null;
  /**
   * kickoff-prompt-absorption-2026-07-17 P-001: whether the server auto-armed
   * this member's engine loop at boot (`autoArmFleetMemberLoop`) — persistence
   * instead of relying solely on the kickoff prompt's in-context self-arm
   * instruction. `null` = not attempted (a leader, an unplanned session, or a
   * non-auto launch); otherwise `{ armed, reason, loopName? }` per the helper.
   */
  loopAutoArm?: { armed: boolean; reason: string; loopName?: string } | null;
  /** Versioned source-of-truth model budget. The launcher preflight and
   * session-port preview consume this exact shape instead of re-deriving a
   * backend window from model-name heuristics. */
  contextBudget?: {
    version: number;
    agent: string;
    model: string | null;
    window: number;
    windowSource: string;
    variant: string;
    promptTokens: number;
    runtimeOverheadTokens: number;
    baselineTokens: number;
    reserveTokens: number;
    availableInputTokens: number;
    level: 'ok' | 'warn' | 'refuse';
    pct: number;
    estimator: string;
  };
  /** Server-owned, token-validated user-turn artifact for a cross-backend
   * port. The launcher passes this only to the managed PTY host; never argv,
   * env, AGENTS.md, or an appended system prompt. */
  sessionPortKickoffFile?: string | null;
  sessionPort?: {
    protocolVersion: number;
    transformVersion: number;
    portId: string;
    sourceAdvSessionId: number;
    renderedHash: string;
    status: 'pending';
  } | null;
}

const options = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const optionsForOptions = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/options',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/**
 * psu-account-chooser P-002: the env patch that pins an interactive psu session to a
 * chosen pool `account`. Mirrors the fleet's gateway routing (operator-spawn →
 * gatewaySpawnEnv) but with an EXPLICIT, validated account instead of the drain
 * selector. `default` is an active route decision: Claude gets an envelope marker
 * that makes the launcher clear every inherited gateway/direct credential before
 * restoring the system login. Explicit `auto`/pin requests fail CLOSED when they
 * cannot be honored — they must never silently become the default system login.
 * Honors the session-override allow/exclude (D-003). Exported so the gating
 * unit-tests can exercise the resolution without the POST handler.
 */
export async function resolveAccountPin(
  workspaceId: string,
  requested: string | null | undefined,
  agent: SuAgent = 'claude',
  ownerId?: string,
  // HARD PIN (account-hard-pin-2026-06-29): when true, the gateway routes this session to its pinned
  // account with NO failover ever (the operator explicitly chose it). The interactive PSU launcher passes
  // true (a person picking an account means "use THIS one"); autonomous role spawns leave it false so the
  // fleet's soft cache-affinity pin (which yields to liveness/load) is unchanged.
  hardPin: boolean = false,
  /** Resolved launch model spec, used to keep OMP's generated gateway provider
   * model-faithful instead of silently selecting its fallback model. */
  model?: string | null,
): Promise<{
  env: Record<string, string>;
  notice: string | null;
  accountId: string | null;
  provider: BackendAccountProvider | null;
  /** Present only when an explicit nondefault route could not be honored. Route
   * handlers reject the launch before recording/spawning anything. */
  error?: string;
  /** WI-3645: explicit-auto routing for a config-FILE-carried backend (codex) — the CODEX_HOME
   *  writers translate this into an UNPINNED gateway provider block (codexGatewayAuto). Claude
   *  auto needs no marker (its routing rides entirely in `env`); absent on pins/default/fail. */
  gatewayAuto?: boolean;
}> {
  const raw = requested?.trim();
  const lower = (raw ?? '').toLowerCase();
  // account-routing-3-options (owner, 2026-06-30): three explicit routing modes carried on the ONE
  // `account` value — so a spawn (psu / fleet) picks exactly how its model calls are routed:
  //  • '' / 'default' / 'none' / 'system' → skip the inference gateway entirely (system credential — the DEFAULT).
  //  • 'auto' / 'gateway'                 → route THROUGH the gateway, which auto-selects an available pool
  //                                         account and fails over (no account-pin header).
  //  • <pool id>                          → pin to that specific account (HARD when hardPin — the PSU pin).
  //
  // default-deploy-account-2026-08-08 P-004 splits what used to be one branch, because the
  // four spellings no longer mean the same thing:
  //   • `none` / `system` — ALWAYS the machine's own login, gateway skipped. The escape hatch
  //     (D-002): once a default account exists this is the only way back to ~/.claude, and the
  //     only recovery path if that account's credential goes bad. Never overridden.
  //   • `default` — an explicit request for the machine's own login, matching the psu
  //     account-routing disclosure. It must never be reinterpreted as the nominated account.
  //   • '' (unspecified) — "whatever the owner nominated". That is the local login ONLY while
  //     no default account is set; otherwise it is that account.
  // WI-42439: the SET lives in agent-config-constants, not here. It used to be spelled out
  // inline, which read as a local detail and was copied wrong by the ACCOUNT chat pill (it
  // tested `=== 'default'` alone and offered live re-pins on `--account=system` sessions
  // that bypass the gateway). Both sides now ask the same predicate.
  const literalSystem = isGatewayFreeAccount(lower);
  const impliedDefault = !raw;
  // OMP default means the selected OMP provider, not a Papercusp account. Do not
  // let a configured Claude default account silently replace an OMP catalog model.
  // Codex also never reads the Claude default-account preference.
  const defaultEligible = impliedDefault && agent === 'claude';
  let defaultAccountId: string | undefined;
  if (defaultEligible) {
    try {
      const { readDefaultAccountId } = await import('../../../deployment/account-pool-store');
      defaultAccountId = await readDefaultAccountId(workspaceId);
    } catch (e) {
      // Fail CLOSED, matching the rule this function already applies to an explicit auto/pin.
      // Silently launching on the system login here would be the exact silent-misroute this
      // feature exists to prevent — and it would look like a perfectly normal launch.
      const why = e instanceof Error ? e.message : String(e);
      const error =
        `could not read the default account (${why}). Refusing to fall back to the default ` +
        `system login, because a default account may be configured and this session would ` +
        `silently egress on the wrong credential.`;
      return { env: {}, notice: error, accountId: null, provider: null, error };
    }
  }
  if (literalSystem || (impliedDefault && (!defaultAccountId || agent === 'omp'))) {
    return {
      // Marker parity with the raw-node launcher. The default route is not the
      // absence of routing state: it actively forces Claude back to the machine's
      // system `/login`, regardless of ambient env inherited from a prior session.
      env: agent === 'claude' ? { PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default' } : {},
      notice: raw ? 'using the default system account (inference gateway skipped).' : null,
      accountId: null,
      provider: null,
    };
  }
  // A configured default routes exactly like `auto` — through the gateway with NO account-pin
  // header — rather than as a pin. That is deliberate and is the whole of D-003: the gateway's
  // resolveAccountPool already returns the default FIRST with every other account behind it, so
  // reusing `auto` gets default-first ordering AND failover for free. Pinning would give the
  // owner's preference the semantics of a hard pin, stranding the session with no fallback the
  // moment that one account hit its rate window.
  const routedByDefault = impliedDefault && !!defaultAccountId;
  const wantAuto = lower === 'auto' || lower === 'gateway' || routedByDefault;
  const id = raw ?? '';
  const label = wantAuto ? 'auto' : id;
  const fail = (why: string) => {
    const error =
      `--account ${label} could not be honored: ${why}. ` +
      'Refusing to fall back to the default system login.';
    return {
      env: {} as Record<string, string>,
      notice: error,
      accountId: null,
      provider: null as BackendAccountProvider | null,
      error,
    };
  };
  const accountGuard = backendFeatureGuard(agent, wantAuto ? 'gateway-routing' : 'account-pinning');
  if (!accountGuard.supported)
    return fail(
      `${wantAuto ? 'gateway routing' : 'account pinning'} is unsupported for ${agent}: ${accountGuard.reason}`,
    );
  const gatewayGuard = backendFeatureGuard(agent, 'gateway-routing');
  if (!gatewayGuard.supported) return fail(`gateway routing is unsupported for ${agent}: ${gatewayGuard.reason}`);
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (!(await getFlag(FLAGS.INFERENCE_GATEWAY, 'system'))) {
      return fail('the inference gateway is off (INFERENCE_GATEWAY)');
    }
    let ompModelRoute: import('@papercusp/orchestrator/omp-gateway-config').OmpGatewayModelRoute | null = null;
    if (agent === 'omp' && model?.trim()) {
      const { ompGatewayModelFromSpec } = await import('../../../inference-gateway/omp-models-config');
      ompModelRoute = ompGatewayModelFromSpec(model);
      if (!ompModelRoute) {
        return fail(`OMP model '${model}' is not compatible with gateway account routing; refusing model substitution`);
      }
    }
    const expected = ompModelRoute?.accountProvider ?? accountProviderForInteractiveBackend(agent);
    if (!expected) return fail(`account routing is unsupported for ${agent}`);
    // Priority label for the admission tier (gateway-priority-tiers): a PSU session is role `su` (tier 2).
    // Without this, pinned/auto psu sessions fell to the default band — tier 5, cap 1 — and their first
    // turns serialized behind each other (the 2026-07-01 "15-minute first turn" starvation). Gated on the
    // same flag as the bee spawn path so flag-OFF emits no new header.
    const priority = (await getFlag(FLAGS.GATEWAY_PRIORITY_TIERS, 'system')) ? 'su' : undefined;
    // AUTO: route through the gateway with NO account pin — it selects an available account + fails over.
    if (wantAuto) {
      const [{ loadAccountPool }, { accountProvider }, { getAccountOverride }] = await Promise.all([
        import('../../../deployment/account-pool-store'),
        import('../../../deployment/account-pool'),
        import('../../../deployment/account-session-override'),
      ]);
      const pool = await loadAccountPool(workspaceId);
      const override = await getAccountOverride(workspaceId);
      const candidates = pool.accounts.filter((candidate) => {
        if (accountProvider(candidate) !== expected) return false;
        if (override.excludeAccounts.includes(candidate.id)) return false;
        return !override.forcedAccounts.length || override.forcedAccounts.includes(candidate.id);
      });
      if (!candidates.length) return fail(`no allowed ${expected} account is available in the pool`);
      if (expected === 'claude' && agent !== 'omp') {
        const { gatewaySpawnEnv } = await import('../../../inference-gateway/spawn-env');
        // ownerId → x-papercusp-owner (attribution + stall-wake); NO accountId → gateway active()/drain + failover.
        return {
          env: {
            ...gatewaySpawnEnv(true, { ownerId, priority }),
            PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto',
          },
          notice: routedByDefault
            ? `routing through the inference gateway, starting on the default account '${defaultAccountId}' (it fails over to the rest of the pool).`
            : 'routing through the inference gateway (auto — it selects an available pool account and fails over).',
          accountId: null,
          provider: expected,
        };
      }
      if (expected === 'codex' && agent !== 'omp') {
        // WI-3645: interactive codex auto. The routing is carried by the per-session CODEX_HOME
        // config.toml, not env — the writer call sites translate `gatewayAuto` into
        // codexGatewayAuto, and the SHARED builder (@papercusp/orchestrator/codex-gateway-config)
        // renders the provider block WITHOUT the x-papercusp-account header; the gateway then
        // auto-selects (bearer pool first, codex-CLI account fallback). The old fail() here
        // rested on a premise the gateway has since outgrown ("needs a specific account") —
        // an unpinned codex request is served, it is not an error.
        return {
          env: {},
          notice: 'routing through the inference gateway (auto — it selects an available codex account).',
          accountId: null,
          provider: expected,
          gatewayAuto: true,
        };
      }
      const { ompGatewayModelsConfig } = await import(
        '../../../inference-gateway/omp-models-config'
      );
      const config = ompGatewayModelsConfig({
        gatewayOn: true,
        provider: ompModelRoute?.gatewayProvider ?? 'anthropic',
        ownerId,
        priority,
        models: ompModelRoute ? [ompModelRoute.modelId] : undefined,
      });
      if (!config) return fail('OMP auto gateway configuration could not be generated');
      return {
        env: {
          PAPERCUSP_OMP_MODELS_YML: config.content,
          PAPERCUSP_OMP_MODEL_SELECTOR: config.modelSelector,
        },
        notice: routedByDefault
          ? `routing OMP through the inference gateway, starting on the default account '${defaultAccountId}' (it fails over to the rest of the pool).`
          : 'routing OMP through the inference gateway (auto — it selects an available pool account and fails over).',
        accountId: null,
        provider: expected,
        gatewayAuto: true,
      };
    }
    const { loadAccountPool } = await import('../../../deployment/account-pool-store');
    const { accountProvider } = await import('../../../deployment/account-pool');
    const pool = await loadAccountPool(workspaceId);
    const acct = (pool.accounts ?? []).find((a: { id: string }) => a.id === id);
    if (!acct) return fail(`'${id}' is not in the account pool (see accounts:list)`);
    const provider = accountProvider(acct as never);
    if (provider !== expected)
      return fail(`'${id}' is a ${provider} account, but ${agent} sessions require ${expected} accounts`);
    if (acct.rate) {
      const { accountFull, accountReadingStatus } = await import('../../../deployment/account-pool');
      const now = Date.now();
      if (
        accountReadingStatus(acct, now).readingStatus === 'fresh' &&
        !acct.rate.lastProbeFailedAt &&
        accountFull(acct, now)
      ) {
        return fail(`'${id}' is measured used up or rate-paused; choose auto or a fresh account`);
      }
    }
    const { getAccountOverride } = await import('../../../deployment/account-session-override');
    const ov = await getAccountOverride(workspaceId);
    if (ov.excludeAccounts.includes(id)) return fail('it is in the session-override exclude list');
    if (ov.forcedAccounts.length > 0 && !ov.forcedAccounts.includes(id)) {
      return fail('it is outside the session-override allow-list (forcedAccounts)');
    }
    if (provider === 'claude' && agent !== 'omp') {
      const { gatewaySpawnEnv } = await import('../../../inference-gateway/spawn-env');
      return {
        // Pass ownerId so the session ALSO sends x-papercusp-owner (not just the account pin) — this lets the
        // gateway attribute the session's routed account (GET /admin/route → the statusline ⇢ <account> chip).
        env: {
          ...gatewaySpawnEnv(true, { accountId: id, ownerId, priority, hardPin }),
          PAPERCUSP_ACCOUNT_ID: id,
          PAPERCUSP_ACCOUNT_ROUTING_MODE: 'pin',
        },
        notice: `pinned to account ${id} (routed through the inference gateway${hardPin ? ', HARD pin — no failover' : ''}).`,
        accountId: id,
        provider,
      };
    }
    // Codex + OMP route via a per-session config FILE (codex CODEX_HOME config.toml /
    // OMP <home>/.omp/agent/models.yml) keyed off PAPERCUSP_ACCOUNT_ID — neither reads
    // the claude CLI's ANTHROPIC_BASE_URL/ANTHROPIC_CUSTOM_HEADERS. OMP pins to a Claude
    // account (provider==='claude') but is delivered the codex-shaped signal, not the
    // claude-CLI env. (omp-account-pinning-gateway-2026-06-29 D-001/D-003)
    if (agent === 'omp') {
      const { ompGatewayModelsConfig } = await import(
        '../../../inference-gateway/omp-models-config'
      );
      const config = ompGatewayModelsConfig({
        accountId: id,
        provider: ompModelRoute?.gatewayProvider ?? 'anthropic',
        ownerId,
        priority,
        models: ompModelRoute ? [ompModelRoute.modelId] : undefined,
      });
      if (!config) return fail('OMP pinned gateway configuration could not be generated');
      return {
        env: {
          PAPERCUSP_ACCOUNT_ID: id,
          PAPERCUSP_OMP_MODELS_YML: config.content,
          PAPERCUSP_OMP_MODEL_SELECTOR: config.modelSelector,
        },
        notice: `pinned to account ${id} (OMP routed through the inference gateway).`,
        accountId: id,
        provider,
      };
    }
    return {
      env: { PAPERCUSP_ACCOUNT_ID: id },
      notice:
        `pinned to Codex account ${id} (routed through the inference gateway).`,
      accountId: id,
      provider,
    };
  } catch (e: any) {
    return fail(`account resolution failed (${e?.message ?? e})`);
  }
}

/**
 * psu-account-chooser P-005: the account choices the interactive psu picker offers.
 * Returns the pool account ids + the active session-override — but ONLY when the
 * inference gateway is on (pinning is a no-op otherwise, so the picker stays hidden
 * and the launch is byte-identical to today). `pool` empty ⇒ the launcher skips the
 * account step entirely. Fail-soft: any error ⇒ no choices (hidden picker). Exported
 * for tests.
 */
export async function resolveAccountChoices(
  workspaceId: string,
  agent: SuAgent = 'claude',
): Promise<{
  gatewayOn: boolean;
  pool: string[];
  forcedAccounts: string[];
  excludeAccounts: string[];
  accountStates?: Record<string, 'available' | 'unavailable' | 'unknown'>;
  provider: BackendAccountProvider | null;
  unsupportedReason?: string;
}> {
  const provider = accountProviderForInteractiveBackend(agent);
  const empty = {
    gatewayOn: false,
    pool: [] as string[],
    forcedAccounts: [] as string[],
    excludeAccounts: [] as string[],
    provider,
  };
  const accountGuard = backendFeatureGuard(agent, 'account-pinning');
  if (!accountGuard.supported)
    return { ...empty, unsupportedReason: accountGuard.reason ?? 'account pinning unsupported' };
  const gatewayGuard = backendFeatureGuard(agent, 'gateway-routing');
  if (!gatewayGuard.supported)
    return { ...empty, unsupportedReason: gatewayGuard.reason ?? 'gateway routing unsupported' };
  if (!provider) return { ...empty, unsupportedReason: `account routing is unsupported for ${agent}` };
  try {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    if (!(await getFlag(FLAGS.INFERENCE_GATEWAY, 'system'))) return empty;
    const { loadAccountPool } = await import('../../../deployment/account-pool-store');
    const { accountsForProvider, accountFull, accountReadingStatus } = await import('../../../deployment/account-pool');
    const accounts = accountsForProvider(await loadAccountPool(workspaceId), provider);
    const pool = accounts.map((a: { id: string }) => a.id);
    const now = Date.now();
    const accountStates = Object.fromEntries(accounts.flatMap((account) => {
      // A legacy/incomplete row has no measured usage state. Never call it
      // available from a missing or stale reading; keep the pin visible with
      // an explicit unknown label so the owner can probe it.
      if (!account.rate) return [];
      const { readingStatus } = accountReadingStatus(account, now);
      const state = readingStatus !== 'fresh' || account.rate.lastProbeFailedAt
        ? 'unknown'
        : accountFull(account, now) ? 'unavailable' : 'available';
      return [[account.id, state]];
    })) as Record<string, 'available' | 'unavailable' | 'unknown'>;
    const { getAccountOverride } = await import('../../../deployment/account-session-override');
    const ov = await getAccountOverride(workspaceId);
    return {
      gatewayOn: true, pool, forcedAccounts: ov.forcedAccounts, excludeAccounts: ov.excludeAccounts,
      ...(Object.keys(accountStates).length ? { accountStates } : {}), provider,
    };
  } catch {
    return empty;
  }
}

/**
 * named-su-agent-fleets P-006: resolve the chosen fleet into the env the spawned
 * agent reads — PAPERCUSP_FLEET_SLUG + PAPERCUSP_FLEET_ROLE (the presence-write
 * path keys off EXACTLY those names). Two shapes, mirroring resolveAccountPin:
 *   - `fleetName` (a freshly-entered name) → CREATE the durable agent_fleets row
 *     (D-001, idempotent) with this agent as owner + leader (D-002); role=leader.
 *   - `fleet` (an existing slug) → JOIN it; role=member (or the requested role).
 * No fleet ⇒ empty env (byte-identical to today). Fail-soft (mirrors the account
 * pin): any error ⇒ no env + a human `notice` the launcher prints, never a throw.
 * Exported so the resolution unit-tests without the POST handler.
 */
/**
 * The COMPOSER-SIDE ROLE CHECK (EI-18278623507151337). Pure + exported for tests.
 *
 * A boot arg is not evidence about who leads a fleet, and on every re-entry into a
 * launch it is actively WRONG: `--fleet=<slug>` hard-sets the role to `member`
 * unconditionally (psu-launcher.mjs:416 and :578 — there is no `--fleet-role=` flag),
 * and `psuLaunchArgvRecord` re-emits only `--fleet=<slug>`, so the role is not carried
 * on `adv_sessions.launch_argv` at all. Any launch rebuilt that way for an agent that
 * DURABLY leads the fleet silently demotes it, and the demotion is what composes a
 * fleet-MEMBER kickoff addressed to an established LEADER: role stamped `member` in the
 * envelope env, the member operating baseline composed for it, its membership stamped as
 * a member. The filed incident is exactly that shape — a leader handed a member brief
 * naming a stale leader and an already-done plan item.
 *
 * `agent_fleets.leader_owner_id` is the durable authority on who leads, and it is
 * already in hand here (`getFleet`) — so a requested `member` that contradicts it is
 * stale by construction and the record wins. The correction is reported so the launcher
 * prints it rather than silently disagreeing with the caller.
 *
 * Deliberately NOT symmetric: a requested `leader` is always honored. Leadership is
 * taken through `fleet:take-leadership` / `setFleetLeader`, and refusing a leader claim
 * here would break the window between a leadership handover and the record catching up.
 */
export function resolveFleetJoinRole(opts: {
  requestedRole?: string | null;
  ownerId?: string | null;
  leaderOwnerId?: string | null;
}): { role: 'leader' | 'member'; demotionRefused: boolean } {
  const requested = opts.requestedRole?.trim() === 'leader' ? 'leader' : 'member';
  if (requested === 'leader') return { role: 'leader', demotionRefused: false };
  const ownerId = opts.ownerId?.trim();
  const leaderOwnerId = opts.leaderOwnerId?.trim();
  const leadsThisFleet = Boolean(ownerId && leaderOwnerId && ownerId === leaderOwnerId);
  return leadsThisFleet
    ? { role: 'leader', demotionRefused: true }
    : { role: 'member', demotionRefused: false };
}

export async function resolveFleet(
  workspaceId: string,
  opts: {
    fleet?: string | null;
    fleetRole?: string | null;
    fleetName?: string | null;
    fleetScheme?: string | null;
    ownerId?: string;
  } = {},
): Promise<{ env: Record<string, string>; notice: string | null; fleetSlug: string | null; fleetRole: string | null }> {
  const name = opts.fleetName?.trim();
  const requested = opts.fleet?.trim();
  if (!name && !requested) return { env: {}, notice: null, fleetSlug: null, fleetRole: null };
  try {
    // WI-1408 concurrency defect (EI-19320623095101585): this module used to have
    // TWO separate `await import('../../../agent-fleets-store')` call sites in this
    // function — this one, and a second at the join branch below for `getFleet`
    // alone. Per the vitest-4 "mock paradox" (P-007 audit 2026-07-11 / EI-9658):
    // two same-literal dynamic-import call sites for one module can resolve
    // one-MOCKED/one-REAL under vi.mock when the co-executing test-file batch is
    // under heavy contention — so under load, the join branch's OWN import could
    // silently escape the test's `vi.mock('../../../agent-fleets-store', …)` and
    // load the REAL store (whose `getFleet` opens a real PG pool), which the
    // unit-layer's PAPERCUSP_FORBID_REAL_PG rail throws on — landing in the catch
    // below and returning a false "does not exist" / fleetSlug:null verdict for a
    // real, existing fleet. Fixed by importing every export this function needs
    // through this SINGLE call site (one import edge, per the established fix
    // pattern) so there is no second dynamic-import call site left to race.
    const { fleetSlugFromName, createFleetIfAbsent, resolveFleetScheme, getFleetScheme, getFleet } =
      await import('../../../agent-fleets-store');
    // The fleet's bound scheme as env the psu launch path reads to recolor the
    // window at startup — so EVERY fleet window (not just capability:terminal)
    // shows the fleet color (fleet-color-schemes: psu/bee terminals). The values
    // are `#rrggbb`, shell-safe; the psu-pty host builds the OSC from them.
    const schemeEnv = (s: { bg: string; fg: string; cursor: string }): Record<string, string> => ({
      PAPERCUSP_FLEET_BG: s.bg,
      PAPERCUSP_FLEET_FG: s.fg,
      PAPERCUSP_FLEET_CURSOR: s.cursor,
    });
    if (name) {
      // A new fleet → create it (idempotent) with this agent as owner + leader.
      const fleetSlug = fleetSlugFromName(name);
      // A scheme chosen in the psu picker forces that catalog colour; an unknown or
      // absent name (a legacy launcher / no pick) leaves it null → the store
      // auto-allocates the next unused scheme (createFleetIfAbsent: colorScheme ?? allocate).
      const { schemeByName } = await import('../../../console-color-schemes');
      const chosenScheme = schemeByName(opts.fleetScheme ?? undefined)?.name ?? null;
      const { record } = await createFleetIfAbsent({
        workspaceId,
        fleetSlug,
        title: name,
        owner: opts.ownerId ?? null,
        leaderOwnerId: opts.ownerId ?? null,
        colorScheme: chosenScheme,
      });
      return {
        env: {
          PAPERCUSP_FLEET_SLUG: fleetSlug,
          PAPERCUSP_FLEET_ROLE: 'leader',
          ...schemeEnv(resolveFleetScheme(record)),
        },
        notice: `leading fleet ${fleetSlug} (${name}).`,
        fleetSlug,
        fleetRole: 'leader',
      };
    }
    // An existing fleet → join it. Default member; honor an explicit leader request.
    // WI-1408 (fleet-join-startup-assertion): validate the slug is a REAL fleet before
    // handing back membership env. Without this, a typo'd/stale `--fleet=<slug>` "succeeded"
    // silently — the agent registered PAPERCUSP_FLEET_SLUG for a fleet row that never
    // existed (a phantom membership, invisible to fleet:assignments' roster of real
    // agent_fleets rows even though the env var itself was non-null).
    const fleetSlug = requested as string;
    const record = await getFleet(workspaceId, fleetSlug);
    if (!record) {
      return {
        env: {},
        notice: `fleet \`${fleetSlug}\` does not exist in this workspace — join skipped (check the slug, or create it first).`,
        fleetSlug: null,
        fleetRole: null,
      };
    }
    const { role, demotionRefused } = resolveFleetJoinRole({
      requestedRole: opts.fleetRole,
      ownerId: opts.ownerId,
      leaderOwnerId: record.leaderOwnerId,
    });
    const scheme = await getFleetScheme(workspaceId, fleetSlug);
    return {
      env: {
        PAPERCUSP_FLEET_SLUG: fleetSlug,
        PAPERCUSP_FLEET_ROLE: role,
        ...(scheme ? schemeEnv(scheme) : {}),
      },
      notice: demotionRefused
        ? `joined fleet ${fleetSlug} as leader — the launch asked for \`member\`, but agent_fleets.leader_owner_id records this agent as the fleet's LEADER, so the durable record wins (a member kickoff would have briefed the leader as one of its own workers; EI-18278623507151337).`
        : `joined fleet ${fleetSlug} as ${role}.`,
      fleetSlug,
      fleetRole: role,
    };
  } catch (e: any) {
    return { env: {}, notice: `fleet selection skipped (${e?.message ?? e}).`, fleetSlug: null, fleetRole: null };
  }
}

/**
 * WI-1893 (cluster-safe fleet stamp): append the launched agent's fleet-membership
 * FACT at boot — durable (harness_shared.fleet_membership_events, WI-1345),
 * worker-agnostic. The prior mechanism (`setPendingFleet`, WI-1343) registered an
 * IN-MEMORY pending placement in whichever cluster worker served bootstrap; the
 * member's first presence write usually lands on a DIFFERENT worker (:3070 is
 * node:cluster + SO_REUSEPORT), so the placement was silently lost and the member
 * registered presence with fleet_slug=null — the 2026-07-03 backlog-clearance batch
 * lost ALL 10 members this way despite `--fleet=<slug>` on every argv. The durable
 * fact + the mig-430 triggers cover both orders: fact-first (materialize_presence_
 * fleet_trg fires on the presence-row INSERT) and row-first (project_fleet_
 * membership_trg fires on the fact INSERT). Populate-once (IfAbsent) so a re-POSTed
 * bootstrap (psu --resume) never clobbers a leadership promotion recorded since.
 *
 * Returns null on success, or the error message — the caller decides loud vs soft
 * (both bootstrap routes fail LOUD when a fleet was explicitly requested, per the
 * WI-1408 no-ghost-member rule).
 */
export async function stampFleetMembershipAtBoot(opts: {
  workspaceId: string;
  ownerId: string;
  ownerLabel?: string | null;
  fleetSlug: string;
  fleetRole?: string | null;
}): Promise<string | null> {
  try {
    const { appendFleetMembershipIfAbsent } = await import('../../../fleet-membership-store');
    await appendFleetMembershipIfAbsent({
      workspaceId: opts.workspaceId,
      ownerId: opts.ownerId,
      ownerLabel: opts.ownerLabel ?? null,
      fleetSlug: opts.fleetSlug,
      fleetRole: opts.fleetRole ?? 'member',
    });
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

/**
 * EI-21005277510954647 — make the bootstrap row hive-visible before turn 1.
 *
 * The OMP session hook can create coord_presence before the launched agent has
 * called coord:orient/coord:declare-intent. That hook does not carry the
 * harness, so a fleet member could be live and fleet-labelled while pot_slug
 * remained null; hive-scoped coord:presence filtered it out before liveness
 * enrichment. Bootstrap already owns the resolved harness and stable owner id,
 * so stamp the same presence row through the canonical writePresence path once
 * the adv_sessions row exists. A role-scoped caller may also provide its fine
 * role (and a null harness for a workspace-level session); SU callers retain the
 * `su` default. The later agent-side declaration remains an idempotent refresh.
 *
 * Presence is recoverable coordination state, unlike the fleet-membership fact,
 * so a transient write failure is returned to the caller for logging but does
 * not abort an otherwise valid session launch.
 */
export async function stampPresenceAtBoot(opts: {
  workspaceId: string;
  ownerId: string;
  ownerLabel?: string | null;
  harnessSlug?: string | null;
  /** Fine-grained role for a role-scoped session; SU launches default to `su`. */
  agentRole?: string | null;
}): Promise<string | null> {
  try {
    const { writePresence } = await import('../../../agent-tools/coordination/presence');
    const agentRole = opts.agentRole?.trim() || 'su';
    await writePresence(
      {
        ownerId: opts.ownerId,
        ownerLabel: opts.ownerLabel?.trim() || `su · ${opts.ownerId.slice(0, 8)}`,
        source: 'omp-hook-session',
        workspaceId: opts.workspaceId,
        userId: null,
      },
      { agentRole },
      opts.harnessSlug,
    );
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

/**
 * EI-11110 / WI-5976 (text-vs-registry authorization contradiction): a fleet/auto
 * launch used to bake "AUTO mode is ON" (and its watermarked, authoritative-
 * looking instructionPrecedence snapshot) into the session PROSE ONLY, computed
 * from the launch request's local `autoMode`/`drainMode` booleans — never written
 * to the actual mode registry (`harness_shared.agent_modes`) that `mode:set` /
 * `coord:orient` read live. A fresh session's first prompt would assert AUTO is
 * on while the very next `coord:orient` call (reading the real registry) reported
 * NO active modes and 'confirm-before-execution' — a live instance of the forged-
 * authority shape WI-5976 describes: authorization expressed as prose that
 * outlives/contradicts the revocable registry state it claims to summarize.
 *
 * This persists the SAME launch-time decision through the identical write path
 * `mode:set` uses (setMode + refreshControlAnchorAfterMutation), so every later
 * live read agrees with the kickoff prose from turn 1 instead of only the
 * one-shot launch snapshot agreeing with itself. Best-effort: a registry hiccup
 * must never fail the launch (the caller awaits this but ignores a thrown error
 * only in the sense of not failing the request — this function itself never
 * throws, returning a message instead, mirroring stampFleetMembershipAtBoot).
 */
export async function syncLaunchModeToRegistry(opts: {
  workspaceId: string;
  ownerId: string;
  autoMode: boolean;
  drainMode: boolean;
  namedMode?: LaunchMode['mode'] | null;
  reason: string;
  /** Bounded named-mode fields forwarded by psu/capability launchers. */
  subject?: string | null;
  instructions?: string | null;
  ownerDirected?: boolean;
}): Promise<string | null> {
  const namedMode = opts.namedMode ?? (opts.drainMode ? 'drain' : null);
  if (!opts.autoMode && !namedMode) return null;
  try {
    const { setMode } = await import('../../../modes/store');
    const { refreshControlAnchorAfterMutation } = await import(
      '../../../agent-tools/coordination/control-anchor'
    );
    const launchMode: LaunchMode | null = namedMode
      ? normalizeLaunchMode({
          mode: namedMode,
          subject: opts.subject,
          instructions: opts.instructions,
          ownerDirected: opts.ownerDirected,
        })
      : null;
    for (const modeId of [...(opts.autoMode ? ['auto'] : []), ...(namedMode ? [namedMode] : [])]) {
      const namedFields =
        modeId === namedMode && (opts.subject !== undefined || opts.ownerDirected !== undefined)
          ? {
              ...(opts.subject !== undefined ? { subject: launchMode?.subject ?? null } : {}),
              ...(opts.ownerDirected !== undefined ? { ownerDirected: launchMode?.ownerDirected === true } : {}),
            }
          : {};
      const res = await setMode({
        workspaceId: opts.workspaceId,
        ownerId: opts.ownerId,
        modeId,
        enabled: true,
        reason: opts.reason,
        setBy: opts.ownerId,
        ...namedFields,
      });
      if (!res.ok && !res.stickyConflict) {
        // A genuine write failure (not the benign already-owner-directed case,
        // which just means a peer/earlier launch already armed it more strongly)
        return res.error ?? `setMode('${modeId}') failed`;
      }
    }
    // D-002: when a launch carries the parent's bounded standing instruction,
    // assert that exact body under the canonical mode key. Do not render it a
    // second time: callers read the already-rendered fact from the parent, and
    // duplicating the prefix would alter the operative instruction on every
    // resumption. A supplied empty value deliberately retracts stale scope.
    if (namedMode && opts.instructions !== undefined) {
      const { assertFact, retractFact } = await import('../../../agent-facts/store');
      const { modeInstructionsFactKey } = await import('../../../agent-tools/mode/set');
      const key = modeInstructionsFactKey(namedMode);
      if (launchMode?.instructions) {
        await assertFact({
          scope: 'owner',
          scopeRef: opts.ownerId,
          key,
          body: launchMode.instructions,
          // P-001/P-002 — declare the lifetime; this write used to take the silent 7d
          // default. Same reasoning as the mode:set writer of this identical key
          // (agent-tools/mode/set.ts): a mode's standing instructions are normative and
          // retract-driven, so kind:'convention' is both the honest modality and the
          // right lifetime — permanent, and out of the cap-eviction population. A drain
          // fleet outliving a week would otherwise silently lose its instructions.
          kind: 'convention',
          sourceRef: `bootstrap-su:launch-mode '${namedMode}' by ${opts.ownerId}`,
          createdBy: opts.ownerId,
          workspaceId: opts.workspaceId,
        });
      } else {
        await retractFact({
          scope: 'owner',
          scopeRef: opts.ownerId,
          key,
          retractedBy: opts.ownerId,
          reason: `bootstrap-su: launch-mode '${namedMode}' instructions cleared`,
          workspaceId: opts.workspaceId,
        });
      }
    }
    await refreshControlAnchorAfterMutation({
      ownerId: opts.ownerId,
      workspaceId: opts.workspaceId,
      origin: 'system',
      actorId: opts.ownerId,
      source: 'mode:set',
    });
    return null;
  } catch (e: any) {
    return e?.message ?? String(e);
  }
}

/** GOAL bootstrap may proceed only after the exact subject and derived posture commit. */
export function attestGoalBootstrapModes(
  subject: string,
  rows: readonly Pick<ModeRow, 'mode' | 'subject' | 'impliedBy'>[],
): { status: 'ready' | 'pending' | 'invalid'; reason?: string } {
  const goal = rows.find((row) => row.mode === 'goal');
  if (!goal) return { status: 'pending' };
  if (goal.subject !== subject) {
    return { status: 'invalid', reason: `GOAL subject ${goal.subject ?? 'null'} does not match ${subject}` };
  }
  for (const mode of ['auto', 'ideate']) {
    const row = rows.find((candidate) => candidate.mode === mode);
    if (!row || row.impliedBy?.mode !== 'goal' || row.impliedBy.subject !== subject) {
      return { status: 'invalid', reason: `${mode} lacks GOAL cascade provenance for ${subject}` };
    }
  }
  return { status: 'ready' };
}

async function awaitGoalBootstrapModes(workspaceId: string, ownerId: string, subject: string): Promise<string | null> {
  const { getModes } = await import('../../../modes/store');
  const deadline = Date.now() + 20_000;
  do {
    const attestation = attestGoalBootstrapModes(subject, await getModes(workspaceId, ownerId));
    if (attestation.status === 'ready') return null;
    if (attestation.status === 'invalid') return attestation.reason ?? 'invalid GOAL mode provenance';
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return `GOAL subject ${subject} was not attached to ${ownerId} within 20 seconds`;
}

/**
 * fleet-auto-mode (WI-1356): the durable AUTO-mode activation a fleet/auto launch
 * bakes into the session — a fleet member has no human at its keyboard, so it must
 * start in the persona's "act, don't ask, loop until done" standing state. Injected
 * into the assembled system prompt (survives compaction) AND prepended to the seeded
 * turn-1 kickoff (so turn 1 enters AUTO). Shared so the two copies never drift.
 */
export const AUTO_MODE_DIRECTIVE =
  'AUTO mode is ON for this session — act on your judgment, do not stop to ask, ' +
  'loop continuously until the work is done. You are a fleet member with no human at your ' +
  'keyboard, so to persist across turns instead of PARKING after turn 1 you MUST ARM A ' +
  'SELF-SUSTAINING LOOP: call loop:arm { intervalSec, goal } toward your assigned work; each ' +
  'wake self-assign + advance a work_item; loop:end ONLY when the goal is done or you are ' +
  "blocked. (The persona's AUTO-mode section governs; the narrow irreversible-high-stakes " +
  'brakes still apply.)';

/**
 * kickoff-prompt-absorption-2026-07-17 P-004: the AUTO activation for a member
 * whose engine loop the server ALREADY armed at boot (P-001's
 * `autoArmFleetMemberLoop`). The "MUST ARM A SELF-SUSTAINING LOOP" compliance
 * clause is replaced by its landed absorber — persistence is now a structural
 * boot-time effect — leaving the one-line "already armed" notice P-004
 * specifies. Everything else (act-don't-ask posture, per-wake work contract,
 * loop:end exit, the persona pointer) is unchanged from AUTO_MODE_DIRECTIVE.
 */
export const AUTO_MODE_DIRECTIVE_LOOP_ARMED =
  'AUTO mode is ON for this session — act on your judgment, do not stop to ask, ' +
  'loop continuously until the work is done. You are a fleet member with no human at your ' +
  'keyboard; your self-sustaining engine loop is ALREADY ARMED server-side, so each wake ' +
  're-invokes you: self-assign + advance a work_item every wake (loop:status inspects it; ' +
  'loop:end + loop:arm retunes it; loop:end ONLY when the goal is done or you are blocked). ' +
  "(The persona's AUTO-mode section governs; the narrow irreversible-high-stakes brakes " +
  'still apply.)';

/** The AUTO activation a launch bakes/prepends, picked by whether P-001's
 *  server-side auto-arm actually took (never assume — a leader, an unplanned
 *  member, a disabled flag, or an arm error all fall back to the full
 *  self-arm instruction). */
export function autoModeDirective(loopAutoArmed: boolean): string {
  return loopAutoArmed ? AUTO_MODE_DIRECTIVE_LOOP_ARMED : AUTO_MODE_DIRECTIVE;
}

/**
 * drain-mode-2026-07-03 (P-003): the durable DRAIN-mode activation a `--mode=drain`
 * launch bakes into the session — the owner's "drain the work queue to terminal"
 * standing state. DRAIN IMPLIES AUTO (the server forces autoMode on), so this
 * directive REPLACES the plain AUTO one (never both) — it carries the act-don't-ask
 * posture itself plus the drain mission loop. Injected into the assembled system
 * prompt (survives compaction) AND prepended to the seeded turn-1 kickoff, same
 * dual delivery as AUTO_MODE_DIRECTIVE. The full operating clause lives in the
 * persona (operating-modes-policy.ts renderModesPolicy, 'full' tier § DRAIN mode);
 * this is the activation + a faithful compression of its 6-step loop.
 */
export const DRAIN_MODE_DIRECTIVE =
  'DRAIN mode is ON for this session — DRAIN implies AUTO mode ON: act on your judgment, do ' +
  'not stop to ask. Your mission is to drain the target work queue to TERMINAL, per the ' +
  "persona's DRAIN-mode section (which governs): (1) TRIAGE + RANK the queue first — the " +
  'ranking IS the batch plan, no hand-built batches; (2) CAPACITY PREFLIGHT before any fleet ' +
  'launch (accounts:status + gateway headroom); (3) CANARY-FIRST bring-up — take fleet ' +
  'leadership as your FIRST act, verify member first-turns via tool_invocations (join ≠ ' +
  'liveness), then loop:arm; (4) FEED BY CLAIM-SPEC (scheduler:set_claim_spec revision bumps ' +
  '+ member scheduler:get_next — never id-pins or hand-assignment); (5) run the lean LEADER ' +
  'LOOP each wake (burn-down delta, member liveness, completion-integrity spot-audits, ' +
  'orphan/stall reclaim, blocked triage); (6) WIND DOWN with loop:end + a final residue ' +
  'report when only owner-gated/live-dep residue remains. NOT licensed: skipping ' +
  'spawn-announcements (account + model), force-deploying past a red gate, or trading ' +
  'completion integrity for speed.';

/**
 * WI-1962: the turn-1 kickoff for a MISSION-BRIEF launch (`--launch-context` with
 * no plan bound). Without it a scripted solo launch boots to an interactive prompt
 * and PARKS FOREVER — claude sat 10+ minutes with a full mission in its system
 * prompt and ZERO turns taken (su-8ab32510, 2026-07-03) until a manual coord wake.
 * The launcher gates delivery exactly like the plan kickoff (--no-picker, not
 * --no-kickoff), so an interactive human launch still opens at an empty prompt.
 */
export const LAUNCH_CONTEXT_KICKOFF =
  'Begin your mission NOW, exactly as your launch brief (the launch-context section of your ' +
  'system prompt) directs. Orient first (coord:orient with a one-line intent), then start the ' +
  'work — do not park waiting for a human turn; this kickoff IS your first turn.';

/**
 * The turn-1 kickoff a launch seeds (EI-5503 + WI-1962 + WI-1356) — pure, exported
 * for tests. A plan-bound launch gets the canonical plan kickoff; a mission-brief
 * (--launch-context, no plan) launch gets the brief kickoff; an AUTO launch prepends
 * the AUTO activation (and kicks off even bare). null ⇒ the launcher seeds nothing
 * (an interactive human launch opens at an empty prompt).
 */
export function deriveKickoffPrompt(opts: {
  planSlug: string | null;
  /** Harness the plan lives in — baked into the kickoff's literal plans:get args
   *  next to the slug (weak-model guard: ornith session 10115 parked on an `ask`
   *  because the kickoff said "the plan" without naming it). */
  harnessSlug?: string | null;
  autoMode: boolean;
  launchContextPath: string | null;
  /** drain-mode P-003: DRAIN launch — the DRAIN activation REPLACES the plain AUTO
   *  one (DRAIN implies AUTO; the directive carries the posture itself). */
  drainMode?: boolean;
  /** kickoff-prompt-absorption P-004: the backend this launch runs on — picks the
   *  kickoff guard profile via kickoffGuardProfileForAgent ('lean' for claude,
   *  whose guards are structural; 'full' for omp/codex/unknown). Omitted ⇒ 'full'
   *  (byte-identical to the pre-P-004 kickoff). */
  agent?: string | null;
  /** kickoff-prompt-absorption P-001/P-004: the server already armed this member's
   *  engine loop at boot — the AUTO activation swaps its "MUST ARM A LOOP" clause
   *  for the one-line "already armed" notice. Omitted/false ⇒ the full self-arm
   *  instruction (the fallback path for a leader / unplanned / arm-failed boot). */
  loopAutoArmed?: boolean;
  /** pot-seat-pools-prose-ux-2026-07-18 P-007/P-013/P-014: the pot-wide remote
   *  seat-offer inventory (resolveRemoteSeatInventory at the call site — this
   *  fn stays synchronous/pure). Only affects the AUTO-OFF routing-gate text;
   *  omitted ⇒ today's static option (C) (no behavior change). */
  remoteSeats?: RemoteSeatSummary | null;
}): string | null {
  const base = opts.planSlug
    ? deriveLaunchPromptText(
        null,
        opts.autoMode,
        {
          slug: opts.planSlug,
          harness: opts.harnessSlug ?? null,
        },
        kickoffGuardProfileForAgent(opts.agent),
        opts.remoteSeats,
      )
    : opts.launchContextPath
      ? LAUNCH_CONTEXT_KICKOFF
      : null;
  const activation = opts.drainMode
    ? [DRAIN_MODE_DIRECTIVE, CONTEXT_DISCIPLINE_DIRECTIVE]
    : opts.autoMode
      ? [autoModeDirective(opts.loopAutoArmed === true), CONTEXT_DISCIPLINE_DIRECTIVE]
      : [];
  return activation.length ? [...activation, base].filter(Boolean).join('\n\n') : base;
}

/**
 * Build the standing launch-provenance fact folded into every cold-wake orient.
 *
 * A concrete launcher owner id is useful provenance, but it is not a durable
 * delivery address: the launcher session can end or fleet leadership can
 * rotate. Named-fleet launches therefore teach the live role selector as the
 * reporting fallback while preserving the original launcher for attribution.
 * Fleetless launches use the durable human owner surface instead, because they
 * have no fleet role selector to resolve after the launcher session ends.
 */
export function launchProvenanceFallbackSentence(fleetSlug?: string | null): string {
  if (!fleetSlug) {
    return (
      'If that session ends, use coord:send with to: ["human"] to reach the owner; ' +
      'this owner surface survives session retirement.'
    );
  }
  return (
    `If that session ends, use coord:send with to: [\"@fleet-leader:${fleetSlug}\"] to reach the current fleet leader; ` +
    'this selector survives session retirement and leadership rotation.'
  );
}

export function buildLaunchProvenanceFactBody(opts: {
  launchedBy: string;
  planSlug?: string | null;
  launchContextPath?: string | null;
  fleetSlug?: string | null;
}): string {
  const provenance =
    `You were launched by ${opts.launchedBy}` +
    (opts.planSlug ? ` on plan ${opts.planSlug}` : '') +
    (opts.launchContextPath ? ` with brief ${basename(opts.launchContextPath)}` : '');

  const liveReportingGuidance = opts.fleetSlug
    ? `They are your original launcher/supervisor for attribution. For live fleet coordination, report milestones + anomalies with coord:send to ["@fleet-leader:${opts.fleetSlug}"]; this selector resolves the current fleet leader across session retirement and leadership rotation. Treat the launcher ID above as attribution only, not as the live fleet recipient.`
    : 'They are your launcher/supervisor; report milestones + anomalies to them while live.';
  return (
    `${provenance}. ${liveReportingGuidance} ` +
    launchProvenanceFallbackSentence(opts.fleetSlug)
  );
}

/**
 * context-trimming-tiers P-007: the context-discipline line a fleet launch bakes
 * next to the AUTO directive — durable system prompt (survives compaction) +
 * turn-1 kickoff, same dual delivery. Six 200k-window members died mid-task on
 * 2026-07-01 ("Prompt is too long") because nothing told them to act on the
 * `context: N/LIMIT (X%)` signal the coord inbox injects (agent-managed-compaction
 * P-007) once the compliance watchdog seeds their limit.
 */
export const CONTEXT_DISCIPLINE_DIRECTIVE =
  'CONTEXT DISCIPLINE: your coord inbox injects a `context: N/LIMIT (X%)` usage line once ' +
  'your session carries a compaction limit. HONOR it — past ~80%, finish the current unit of ' +
  'work, write durable state (plan `## Now` / work_items:checkpoint), then call ' +
  'session:request-compaction at that clean stopping point. Do NOT run to the hard window: ' +
  '"Prompt is too long" kills the session mid-task and loses your in-flight work. On a ' +
  'trimmed session, tool payloads are already tier-shaped; pass payloadTier:"full" on a call ' +
  'only when you genuinely need the unshaped result.';

/**
 * The AUTO/DRAIN section a launch appends to the assembled system prompt — '' when
 * the session is neither. Shared with the carry-respawn persona refresh
 * (stale-prompt-render-in-live-sessions-2026-08-02 P-002) so a re-rendered prompt
 * carries byte-identical mode prose; it lives HERE, next to the directives it
 * composes and the kickoff that shares them, rather than in `su-persona-render`.
 *
 * drain-mode P-003: the DRAIN section REPLACES the plain AUTO one — the DRAIN
 * directive carries the act-don't-ask posture itself (DRAIN implies AUTO), so
 * baking both would just double-print the activation.
 */
export function composeModePromptSection(opts: {
  autoMode: boolean;
  drainMode: boolean;
  loopArmed: boolean;
}): string {
  if (opts.drainMode) {
    return `---\n## DRAIN mode\n\n${DRAIN_MODE_DIRECTIVE}\n\n${CONTEXT_DISCIPLINE_DIRECTIVE}\n`;
  }
  if (opts.autoMode) {
    return `---\n## AUTO mode\n\n${autoModeDirective(opts.loopArmed)}\n\n${CONTEXT_DISCIPLINE_DIRECTIVE}\n`;
  }
  return '';
}

/**
 * launch-path-argv-reconstruction (WI-1343): normalize a caller-supplied
 * `launch_argv` (the literal `psu …` invocation the launcher built) into the
 * string[] recorded on `adv_sessions.launch_argv`. Defensive: only strings,
 * each length-capped, the array element-capped — an untrusted body must never
 * bloat the row or poison the JSONB. Returns null when nothing usable was sent
 * (the caller then falls back to a server-side reconstruction). Exported for tests.
 */
export function normalizeLaunchArgv(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 2000));
  return out.length ? out.slice(0, 128) : null;
}

/**
 * launch-path-argv-reconstruction (WI-1343): the server-side FALLBACK argv for a
 * bootstrap-su launch whose caller did not send an explicit `launch_argv` (a
 * direct/web POST, or a launcher that predates the field). Reconstructs the
 * canonical `psu …` invocation from the RESOLVED launch fields so a killed batch
 * is still reconstructible. The psu launcher itself sends the literal argv (which
 * wins); this is the belt-and-suspenders path. Pure — exported for tests.
 */
export function reconstructPsuLaunchArgv(o: {
  agent: string;
  model?: string | null;
  modelSource?: 'explicit' | 'inherited' | 'configured-default' | null;
  headless?: boolean;
  harnessSlug?: string | null;
  planSlug?: string | null;
  profile?: string | null;
  contextSize?: string | null;
  account?: string | null;
  fleet?: string | null;
  /** WI-1347: a role-scoped launch (`psu --role=<role>`, bootstrap-role's path)
   *  reduces to `--role=` instead of `--profile=` — mutually exclusive with
   *  `profile` at the call site. Omitted ⇒ byte-identical to the pre-WI-1347
   *  plain-SU/engineer reconstruction below. */
  role?: string | null;
  /** Repeatable launch-time identity bindings. */
  stack?: readonly string[] | null;
}): string[] {
  const argv = ['psu', '--no-picker', `--agent=${o.agent}`];
  if (o.headless) argv.push('--headless');
  if (o.role) argv.push(`--role=${o.role}`);
  for (const ref of o.stack ?? []) if (ref) argv.push(`--stack=${ref}`);
  if (o.harnessSlug) argv.push(`--harness=${o.harnessSlug}`);
  argv.push(o.planSlug ? `--plan=${o.planSlug}` : '--no-plan');
  if (!o.role && o.profile && o.profile !== 'engineer') argv.push(`--profile=${o.profile}`);
  if (o.contextSize) argv.push(`--context-size=${o.contextSize}`);
  if (o.account) argv.push(`--account=${o.account}`);
  if (o.agent === 'codex') argv.push(`--model=${resolveCodexModel(o.model)}`);
  if (o.agent === 'codex' && o.modelSource) argv.push(`--model-source=${o.modelSource}`);
  if (o.fleet) argv.push(`--fleet=${o.fleet}`);
  return argv;
}

const brainGet = defineTool({
  method: 'GET',
  path: '/agent-mcp/console/bootstrap-su/brain',
  auth: 'public',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    return jsonRes(
      { status: 'error', error: 'psu --brain is deprecated; use operator/sentinel converse or a normal psu session.' },
      410,
    );
  },
});

/**
 * GET /api/agent-mcp/console/bootstrap-su/options
 *
 * Picker data for the `psu` launcher (and the /adv "Launch SU" modal).
 * Harnesses are workspace-scoped, so the picker walks workspace → harness
 * → plan:
 *   - no query                   → { activeWorkspace, workspace, workspaces:
 *                                    [{ id, name }], harnesses: [{ slug, path, status }] }
 *   - ?workspace=<id>            → harnesses for that workspace
 *   - ?workspace=<id>&harness=<slug> → { plans: [{ slug }] } (non-archived)
 * `workspace` defaults to the active workspace when omitted.
 */
const optionsGet = defineTool({
  method: 'GET',
  path: '/agent-mcp/console/bootstrap-su/options',
  auth: 'public',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    const url = new URL(req.url);
    const workspace = url.searchParams.get('workspace')?.trim() || activeWorkspaceId();
    const harness = url.searchParams.get('harness')?.trim() || null;
    const wantFeatures = url.searchParams.get('features') === '1';
    const wantIdentities = url.searchParams.get('identities') === '1';
    const accountAgentRaw = url.searchParams.get('agent')?.trim();
    const accountAgent = isSuAgent(accountAgentRaw) ? accountAgentRaw : 'claude';

    // The launcher and Settings page share the existing source catalog. Page
    // by source candidates so an invalid entry stays visible with its reason.
    if (wantIdentities) {
      try {
        const [{ listIdentitySources }, { resolveProjectDir }, { papercuspPathForWorkspace }] = await Promise.all([
          import('../../../agent-identities/source'),
          import('../../../spawn-config'),
          import('../../../papercusp-root'),
        ]);
        const repoDir = harness ? await resolveProjectDir(harness, workspace)
          : papercuspPathForWorkspace(workspace);
        if (!repoDir) return jsonRes({ status: 'error', error: 'harness not registered in workspace' }, 404);
        const requestedLimit = Number(url.searchParams.get('limit'));
        const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
          ? Math.min(requestedLimit, 100) : 30;
        const catalog = await listIdentitySources({
          repoDir,
          after: url.searchParams.get('after')?.trim() || undefined,
          limit,
        });
        return jsonRes({ status: 'ok', workspace, harness,
          identities: catalog.identities, unreadable: catalog.unreadable,
          scanned: catalog.scanned, nextAfter: catalog.nextAfter });
      } catch (error) {
        return jsonRes({ status: 'error', error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    // ?harness=X&features=1 → feature list (for the psu --role feature picker).
    if (harness && wantFeatures) {
      try {
        const { listFeaturesForHarness } = await import('../../../harness-readers');
        const r = await listFeaturesForHarness(harness, 'staging');
        const features = r.ok
          ? (
              r.data.features as Array<{
                id?: string;
                feature_id?: string;
                title?: string;
                description?: string;
                status?: string;
              }>
            )
              .map((f) => ({
                id: f.id ?? f.feature_id ?? '',
                title: f.title ?? f.description ?? '',
                status: f.status ?? null,
              }))
              .filter((f) => f.id)
          : [];
        return jsonRes({ status: 'ok', workspace, harness, features });
      } catch (e: any) {
        return jsonRes({ status: 'error', error: e?.message ?? 'features listing failed' }, 400);
      }
    }

    if (harness) {
      try {
        const { resolveHarnessPlansDir, listPlanFiles } = await import('../../../agent-tools/plans/source');
        const resolved = await resolveHarnessPlansDir(harness, { workspaceId: workspace });
        const entries = await listPlanFiles({ harnessSlug: resolved.harnessSlug, workspaceId: resolved.workspaceId });
        return jsonRes({
          status: 'ok',
          workspace,
          harness,
          plans: entries.filter((e) => !e.archived).map((e) => ({ slug: e.slug })),
        });
      } catch (e: any) {
        return jsonRes({ status: 'error', error: e?.message ?? 'plans listing failed' }, 400);
      }
    }

    const { listHarnessesFor } = await import('../../../device-harnesses');
    const harnesses = (await listHarnessesFor(workspace)).map((h) => ({
      slug: h.slug,
      path: h.path,
      status: h.status,
    }));
    const workspaces = readRegistry().workspaces.map((w) => ({ id: w.id, name: w.name }));
    // Roles + their consumes (feature/plan needs) for the psu --role picker.
    const { getKnownRoles } = await import('../../../known-roles');
    const { roleConsumes } = await import('../../../role-registry');
    const roles = getKnownRoles().map((id) => ({ id, consumes: roleConsumes(id, harness ?? '') }));
    // psu-account-chooser P-005: pool accounts the interactive picker offers (empty +
    // hidden unless the gateway is on — see resolveAccountChoices).
    const accounts = await resolveAccountChoices(workspace, accountAgent);
    // D-001: OMP remains the source of truth. A catalog read failure must not
    // take down the rest of the launch picker, but it must remain observable —
    // an empty successful catalog and an unavailable catalog are different.
    let ompCatalog:
      | {
          status: 'available';
          source: 'omp models --json';
          availability: 'enabled-configured';
          credentials: 'unchecked';
          upstream: 'unchecked';
          models: OmpModelCatalogEntry[];
        }
      | {
          status: 'unavailable';
          source: 'omp models --json';
          availability: 'unknown';
          credentials: 'unchecked';
          upstream: 'unchecked';
          models: [];
          error: string;
        };
    try {
      const { models } = await readOmpModelCatalog();
      ompCatalog = {
        status: 'available',
        source: 'omp models --json',
        availability: 'enabled-configured',
        credentials: 'unchecked',
        upstream: 'unchecked',
        models,
      };
    } catch (error) {
      ompCatalog = {
        status: 'unavailable',
        source: 'omp models --json',
        availability: 'unknown',
        credentials: 'unchecked',
        upstream: 'unchecked',
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // named-su-agent-fleets P-006: the durable named fleets this workspace offers
    // for the psu fleet picker. Persist even with zero live members (D-003), so
    // this is the "pick existing fleet" list. Fail-soft: any error ⇒ [] (the picker
    // still shows its "no fleet" / "create new" rows).
    // fleet-color-schemes: carry each fleet's resolved color so the picker can
    // show a swatch, plus `nextScheme` — the color a NEW fleet would be allocated
    // — so the "create a new fleet" row previews its eventual color too.
    type SchemeColor = { name: string; bg: string; fg: string; cursor: string };
    let fleets: Array<{ slug: string; title: string | null; scheme: string | null; color: SchemeColor }> = [];
    let nextScheme: SchemeColor | null = null;
    // The full curated catalog (name + colours) so the psu picker can offer a
    // scheme SELECTOR with per-row swatches when creating a new fleet.
    let schemes: SchemeColor[] = [];
    try {
      const { listFleets, resolveFleetScheme } = await import('../../../agent-fleets-store');
      const { COLOR_SCHEMES, allocateNextSchemeName, schemeByName } = await import('../../../console-color-schemes');
      schemes = COLOR_SCHEMES.map((s) => ({ name: s.name, bg: s.bg, fg: s.fg, cursor: s.cursor }));
      const rows = await listFleets(workspace);
      fleets = rows.map((f) => ({
        slug: f.fleetSlug,
        title: f.title,
        scheme: f.colorScheme,
        color: resolveFleetScheme(f),
      }));
      // Deterministic given the current in-use set — the create path re-derives
      // the same one, so this preview matches what the new fleet actually gets.
      const used = rows.map((f) => f.colorScheme).filter((n): n is string => !!n);
      nextScheme = schemeByName(allocateNextSchemeName(used)) ?? null;
    } catch {
      /* fleet listing is optional — proceed without it */
    }
    return jsonRes({
      status: 'ok',
      activeWorkspace: activeWorkspaceId(),
      workspace,
      workspaces,
      harnesses,
      roles,
      accounts,
      ompCatalog,
      fleets,
      nextScheme,
      schemes,
    });
  },
});

export const bootstrapSu = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su',
  // Bootstrap is an idempotency-keyed launch transaction. A slow first request
  // may finish after the route stack's default 30s watchdog; aborting then
  // converts its committed success into a 408 that psu cannot use. The psu
  // client and MCP proxy own bounded transport waits and same-key recovery.
  timeoutSec: null,
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    // gatePrincipal deliberately keeps its historical Response|null contract for
    // the sibling routes. Resolve once more here because P-009 needs the actual
    // authenticated principal slug, not the currently worn identity or launcher.
    const launchPrincipal = await requirePrincipal(req.headers).catch(() => null);

    let body: {
      agent?: string;
      workspace?: string | null;
      harness_slug?: string | null;
      plan_slug?: string | null;
      label?: string | null;
      /** Playbook profile (engineer|power), assembled per-launch (P-023).
       *  Omitted/invalid → 'engineer'. */
      profile?: string | null;
      /** EI-996: a SU-TIER ROLE NAME (e.g. 'planner') — this session runs as a
       *  full su agent whose prompt carries that role's addendum. Deliberately a
       *  NAME, not prose: the text is resolved server-side from
       *  `prompts/su-role-<role>.addendum.md`, so this superuser-tier launch path
       *  exposes no free-text prompt-append surface. Unknown → 400. */
      su_role?: string | null;
      /** Explicit launch-time identity binding, using repeatable `slot:id` refs.
       * Omitted lets the selected blueprint role's `roles[].stack` default apply. */
      stack?: string[] | null;
      /** Exact source revision chosen by the interactive identity picker. */
      selected_identity_revision?: string;
      /** The launcher's own cwd — used for no-harness launches so the
       *  agent's cwd-scoped session resume works from the user's terminal. */
      cwd?: string | null;
      /** `caller` runs a HARNESS launch in `cwd` too (PUI's chat-first
       *  default, pui-chat-first-ux P-001); omitted keeps the harness repo.
       *  See resolveSuLaunchCwd for the $HOME / missing-directory fallbacks. */
      cwd_policy?: SuLaunchCwdPolicy | null;
      /** Deprecated tombstone input. When true, this route returns 410. */
      brain?: boolean;
      /** psu-account-chooser P-002: pin this interactive session to a specific pool
       *  account. Routed through the gateway (gatewaySpawnEnv) when INFERENCE_GATEWAY
       *  is on + the id is a valid, allowed pool account. Explicit auto/pin requests
       *  fail closed when unavailable; default/omitted uses the system login. */
      account?: string | null;
      /** named-su-agent-fleets P-006: the durable slug of a named fleet to JOIN
       *  (member). Folded into PAPERCUSP_FLEET_SLUG/PAPERCUSP_FLEET_ROLE on the
       *  spawn env. Ignored when `fleet_name` is present (a new fleet wins). */
      fleet?: string | null;
      /** Membership role for `fleet` — 'leader' | 'member' (default member). */
      fleet_role?: string | null;
      /** named-su-agent-fleets P-006: a freshly-entered fleet NAME. The server
       *  derives its slug (fleetSlugFromName) + creates the agent_fleets row, and
       *  this agent becomes the leader (D-002). */
      fleet_name?: string | null;
      /** fleet-color-schemes: a catalog scheme NAME chosen in the psu picker for a
       *  NEW fleet (with `fleet_name`). Forces that colour; an unknown/absent value
       *  auto-allocates the next unused scheme. Ignored for an existing-fleet join. */
      fleet_scheme?: string | null;
      /** agent-allocation P-005 (launch-from-seats): the delegated agent_slot
       *  template this member consumes ('<model>:<effort>:<account>', `psu
       *  --seat=<ref>`). Recorded in the consumption ledger (mig 487) keyed to
       *  the session's coord owner id — the boot-time seat-cap backstop refuses
       *  the over-cap member (P-006). Requires `fleet`. */
      seat?: string | null;
      /** Optional kickoff/launch-context file generated by the operator UI.
       * Claude/OMP receive this as an extra system prompt from the launcher;
       * Codex has no such flag, so bootstrap folds it into AGENTS.md. */
      launch_context?: string | null;
      /** solo-launch-provenance (WI-1962 sibling): the ownerId of the agent/session
       *  that LAUNCHED this one (`psu --launched-by=<ownerId>`; capability:terminal
       *  auto-injects it into psu commands). Baked into the system prompt, exported
       *  as PAPERCUSP_LAUNCHED_BY, and asserted as an owner-scoped standing fact —
       *  so the launched agent can always answer "who launched/supervises you"
       *  (su-8ab32510 2026-07-03 couldn't: no provenance existed anywhere). */
      launched_by?: string | null;
      /** su-context-size-variants: 'full' | 'trimmed' — the initial-context size. */
      context_size?: string | null;
      /** context-trimming-tiers P-017: persona tier — 'full' (today's playbook) |
       *  'fleet' (spine-only fleet-member tier). Omitted ⇒ auto-select from the
       *  model window in buildLaunchSpec (≤200k known model → fleet). */
      persona_tier?: string | null;
      /** weak-model-tool-tier: the model id the session launches with (e.g.
       *  `ollama/ornith-35b`, `anthropic/claude-opus-4-8`). Drives the tool-tier
       *  gate in buildLaunchSpec — a WEAK/local model is hard-trimmed to the core
       *  spine (codex path; omp trims client-side in psu-launcher; claude self-trims).
       *  Absent ⇒ 'frontier' tier (no trim) — the safe default. */
      model?: string | null;
      model_source?: 'explicit' | 'inherited' | 'configured-default' | null;
      /** Explicit windowless/unattended posture. Older launcher builds are
       *  recognized from launch_argv's exact --headless discriminator. */
      headless?: boolean | null;
      /** launch-path-argv-reconstruction (WI-1343): the literal `psu …` argv the
       *  launcher built, recorded on adv_sessions.launch_argv so a killed batch is
       *  reconstructible. Validated + capped server-side (normalizeLaunchArgv);
       *  omitted ⇒ the server reconstructs it from the resolved fields. */
      launch_argv?: unknown;
      /** fleet-auto-mode (WI-1356): start this session in AUTO mode (act/don't-ask/
       *  loop). The launcher sets it for `--fleet` launches (default) or an explicit
       *  `--auto`. When true, bake the durable AUTO directive into the system prompt
       *  and prepend the AUTO activation to the seeded kickoff. */
      auto?: boolean;
      /** headless-fleet-launch-and-carry-knob: the explicit per-member carry mode
       *  from `psu --carry`; it must reach autoArmFleetMemberLoop rather than being
       *  used only as launch_argv attestation. */
      carry?: 'warm' | 'cold' | null;
      /** drain-mode-2026-07-03 P-003: named operating mode for this launch. The only
       *  recognized value is 'drain' (`psu --mode=drain`) — start the session in DRAIN
       *  mode (drain the target work queue to terminal; the persona's DRAIN-mode
       *  section governs). DRAIN IMPLIES AUTO: it forces `autoMode` on and bakes the
       *  DRAIN directive (instead of the plain AUTO one) into system prompt + kickoff.
       *  Unknown values are refused loudly (400) — never silently ignored. */
      mode?: string | null;
      /** Bounded DRAIN scope payload propagated from the launching session. */
      mode_subject?: string | null;
      mode_instructions?: string | null;
      mode_owner_directed?: boolean | null;
      /** A bootstrap-only assertion: wait for this GOAL attachment, then attest
       * its subject and AUTO/IDEATE cascade before returning a runnable session. */
      goal_bootstrap_subject?: string | null;
      /** Cross-backend port handshake. Both fields are mandatory together;
       * unknown versions fail before any adv/session artifact is created. */
      session_port_protocol?: number;
      session_port_transform_version?: number;
      session_port_token?: string | null;
      /** Pre-pinned coord owner id (`psu --owner-id=<su-…>`) — the programmatic-spawner
       *  contract (WI-5002/EI-13277): a spawner that must key per-session state to the
       *  session it launches (doors overrides, transcript reads) supplies the owner id
       *  up front instead of discovering the server-minted one after the fact (the env
       *  PAPERCUSP_SID it exports is overridden by this envelope, so pre-pinning is the
       *  only reliable binding). Validated + live-collision-checked below; omitted ⇒
       *  server mints (today's behavior). */
      owner_id?: string | null;
      /** WI-41363: stable client-generated key for replaying this fresh bootstrap
       * after the MCP proxy accepted the request but lost its response headers. */
      bootstrap_idempotency_key?: unknown;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return jsonRes({ status: 'error', error: 'invalid JSON body' }, 400);
    }

    if (!isSuAgent(body.agent)) {
      return jsonRes(
        { status: 'error', error: `agent must be one of claude|omp|codex (got ${String(body.agent).slice(0, 24)})` },
        400,
      );
    }
    const agent: SuAgent = body.agent;
    const workspace = body.workspace?.trim() || activeWorkspaceId();
    const rawGoalBootstrapSubject = body.goal_bootstrap_subject;
    const goalBootstrapSubject = typeof rawGoalBootstrapSubject === 'string'
      ? rawGoalBootstrapSubject.trim() : null;
    if (rawGoalBootstrapSubject != null && (!goalBootstrapSubject || goalBootstrapSubject.length > 200)) {
      return jsonRes({ status: 'error', error: 'goal_bootstrap_subject must be a non-empty string of at most 200 characters' }, 400);
    }
    if (goalBootstrapSubject && (typeof body.owner_id !== 'string' || !body.owner_id.trim() || body.auto === true || body.mode || body.fleet || body.fleet_name)) {
      return jsonRes({ status: 'error', error: 'GOAL bootstrap requires a pre-pinned owner without separate AUTO, DRAIN, or fleet mode' }, 400);
    }
    // isKnownWorkspace (NOT raw workspaceById): the literal 'default' sentinel — what
    // activeWorkspaceId() itself returns on a sparse/fresh registry, and what the
    // /options endpoint hands the launcher as `activeWorkspace` — is ALWAYS valid, as is
    // a PAPERCUSP_WORKSPACE_ID process pin. A plain workspaceById() rejected the exact
    // value this route's own resolver produces, 400ing `unknown workspace: default` on
    // every fresh packaged install (psu launch) even though nothing was wrong (WI-3234).
    if (body.workspace?.trim() && !isKnownWorkspace(workspace)) {
      return jsonRes({ status: 'error', error: `unknown workspace: ${workspace.slice(0, 48)}` }, 400);
    }
    const rawBootstrapIdempotencyKey = body.bootstrap_idempotency_key;
    const bootstrapIdempotencyKey =
      typeof rawBootstrapIdempotencyKey === 'string'
        ? rawBootstrapIdempotencyKey.trim()
        : null;
    if (
      rawBootstrapIdempotencyKey != null &&
      (typeof rawBootstrapIdempotencyKey !== 'string' ||
        !bootstrapIdempotencyKey ||
        bootstrapIdempotencyKey.length > 200)
    ) {
      return jsonRes(
        {
          status: 'error',
          error: 'bootstrap_idempotency_key must be a non-empty string of at most 200 characters',
        },
        400,
      );
    }
    // Prefix the shared ledger key so a caller cannot collide with the outer
    // capability:launch-agent invocation that opened this psu process.
    const bootstrapLedgerKey = bootstrapIdempotencyKey
      ? `bootstrap-su:${bootstrapIdempotencyKey}`
      : null;
    const harnessSlug = body.harness_slug?.trim() || null;
    const planSlug = body.plan_slug?.trim() || null;
    const callerCwd = body.cwd?.trim() || null;
    // P-023: playbook profile. Valid base playbooks (prompts/papercusp-su-<profile>.tools.md):
    // 'engineer' (working ON papercusp) | 'power' (managing an external repo) |
    // 'generic' (a NON-CODING work hive — domain-generic-hive-architecture P-025: skips
    // papercup's repo CLAUDE.md, pulls domain context from the per-hive su override).
    // Anything else → 400 so a typo doesn't silently fall back. Omitted → engineer.
    const profileRaw = body.profile?.trim() || null;
    if (profileRaw && profileRaw !== 'engineer' && profileRaw !== 'power' && profileRaw !== 'generic') {
      return jsonRes(
        { status: 'error', error: `profile must be engineer|power|generic (got ${profileRaw.slice(0, 24)})` },
        400,
      );
    }
    const profile = profileRaw ?? 'engineer';

    // EI-996 (owner ask 2026-06-17): a SU-TIER ROLE — the session is a full su
    // agent (engineer playbook + superuser MCP) plus that role's few lines. The
    // wire carries the role NAME and the text is resolved here from
    // prompts/su-role-<role>.addendum.md; an unknown name 400s exactly like an
    // unknown profile above, so a typo can never silently launch an unaddended
    // superuser session that LOOKS like a role session. Never accept the prose
    // itself over the wire — see su-role-addendum.ts for why.
    const suRoleRaw = body.su_role?.trim() || null;
    if (suRoleRaw && !isSuTierRole(suRoleRaw)) {
      return jsonRes(
        {
          status: 'error',
          error: `su_role must be one of ${SU_TIER_ROLES.join('|')} (got ${suRoleRaw.slice(0, 24)})`,
        },
        400,
      );
    }
    const roleAddendum = suRoleRaw ? resolveSuRoleAddendum(suRoleRaw) : null;
    if (
      body.stack != null &&
      (!Array.isArray(body.stack) ||
        body.stack.length > 40 ||
        body.stack.some((ref) => typeof ref !== 'string' || !ref.trim()))
    ) {
      return jsonRes({ status: 'error', error: 'stack must be an array of 1-40 non-empty slot:id refs' }, 400);
    }
    if (body.selected_identity_revision !== undefined &&
        (!/^[a-f0-9]{64}$/.test(body.selected_identity_revision) || body.stack?.length !== 1)) {
      return jsonRes({ status: 'error', error: 'selected_identity_revision requires one selected stack ref and a sha256 revision' }, 400);
    }

    // Trimmed is the only effective launch mode. `full` remains a compatibility
    // alias for historical rows/clients and is normalized before any mutation.
    const normalizedContextSize = normalizeSuContextSize(body.context_size);
    if (!normalizedContextSize.ok) {
      return jsonRes({ status: 'error', error: normalizedContextSize.error }, 400);
    }
    const contextSize = normalizedContextSize.contextSize;
    // context-trimming-tiers P-017: persona tier (validated; omitted ⇒ model-window auto-select).
    const personaTierRaw = body.persona_tier?.trim() || null;
    if (personaTierRaw && personaTierRaw !== 'full' && personaTierRaw !== 'fleet') {
      return jsonRes(
        { status: 'error', error: `persona_tier must be full|fleet (got ${personaTierRaw.slice(0, 24)})` },
        400,
      );
    }
    const personaTier = personaTierRaw as 'full' | 'fleet' | null;
    if (body.headless != null && typeof body.headless !== 'boolean') {
      return jsonRes({ status: 'error', error: 'headless must be a boolean' }, 400);
    }
    const normalizedLaunchArgv = normalizeLaunchArgv(body.launch_argv);
    const headless = body.headless === true || normalizedLaunchArgv?.includes('--headless') === true;
    // `--no-picker` is unattended even when it still owns a visible terminal:
    // nobody made the interactive backend selection that authorizes the
    // configured platform default (D-002). Keep this separate from `headless`,
    // which controls the actual window/process posture below.
    const unattended = headless || normalizedLaunchArgv?.includes('--no-picker') === true;
    if (body.carry != null && body.carry !== 'warm' && body.carry !== 'cold') {
      return jsonRes(
        { status: 'error', error: `carry must be warm|cold (got ${String(body.carry).slice(0, 24)})` },
        400,
      );
    }
    const carry = body.carry ?? null;

    const brain = body.brain === true;
    if (brain) {
      return jsonRes(
        {
          status: 'error',
          error: 'brain launches are deprecated; use operator/sentinel converse or a normal psu session.',
        },
        410,
      );
    }

    // Resolve cwd + context env from the existing console envelope builder
    // (shell mode), scoped to the chosen workspace. We use its env + cwd;
    // the prompt + MCP come from buildLaunchSpec(su) below.
    let envelope;
    try {
      envelope = await buildConsoleEnvelope({
        workspaceId: workspace,
        slug: harnessSlug,
        operatorBaseUrl: new URL(req.url).origin,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'envelope build failed' }, 400);
    }

    // cwd: a harness launch runs in the harness repo (envelope.cwd). A
    // no-harness launch prefers the launcher's own cwd (the user's
    // terminal) over the internal .papercusp dir — agents scope their
    // resumable sessions by cwd, so this makes `--resume` work from where
    // the user is. Recorded + returned + exec'd consistently.
    //
    // EI-202 guard: never run a psu session in $HOME. At $HOME the cwd-level
    // CLAUDE.md / .claude/CLAUDE.md ARE the owner's personal config, which
    // Claude auto-loads as PROJECT memory — re-importing exactly the personal
    // instructions P-002 skip-links out of the per-session CLAUDE_CONFIG_DIR
    // (config-dir isolation governs GLOBAL memory only, not cwd project memory).
    // resolveSuLaunchCwd relocates a $HOME cwd to envelope.cwd (never $HOME).
    // `cwd_policy:'caller'` (PUI chat-first) runs a harness launch where the
    // user launched it, when this host can see that directory.
    const cwd = resolveSuLaunchCwd({ harnessSlug, callerCwd, envelopeCwd: envelope.cwd,
      policy: body.cwd_policy === 'caller' ? 'caller' : 'harness' });

    // Selected identity defaults must reach native configuration, account routing
    // and the model-tier prompt budget. Explicit launch choices still win.
    let identityModelDefault: string | null;
    try {
      identityModelDefault = await resolveLaunchIdentityModelDefault({
        cwd, harnessSlug, role: suRoleRaw ?? 'su', stack: body.stack,
      });
    } catch (error: any) {
      return jsonRes({ status: 'error', code: 'identity_model_default_denied', error: error?.message ?? String(error) }, 400);
    }
    const suppliedModel = body.model?.trim() || null;
    const requestedModel = body.model_source === 'configured-default' ? null : suppliedModel;
    let model = requestedModel ?? identityModelDefault ?? suppliedModel;
    let modelSource: 'explicit' | 'inherited' | 'configured-default' | null = null;
    if (agent === 'codex') {
      try {
        const selection = resolveCodexModelSelection(model, {
          source: !requestedModel && identityModelDefault ? 'inherited' :
            body.model_source ??
            (requestedModel ? 'explicit' : unattended ? 'explicit' : 'configured-default'),
        });
        model = selection.model;
        modelSource = selection.source;
      } catch (error: any) {
        return jsonRes({ status: 'error', code: error?.code ?? 'codex_model_denied', error: error?.message ?? String(error) }, 400);
      }
    }

    // Fetch the bound plan's `## Now` + title for the launch-context addendum
    // (best-effort — buildLaunchSpec composes the addendum from these). Lives in
    // su-persona-render so the carry-respawn refresh resolves plan context through
    // the SAME code, including the WI-1442 liveness decoration of su-* mentions.
    const { planNow, planTitle } = await resolveSuPlanContext({
      planSlug,
      harnessSlug,
      workspaceId: workspace,
    });

    // Build the su launch spec: engineer playbook + per-launch scope/plan
    // addendum (promptText) + the superuser MCP url (codex consumes it). The
    // SAME builder roles use, at the superuser tier (D-001).
    // identities-v1 P-012 / P-021: the fleet posture the session launches INTO and the modes
    // it launches WITH, so the FIRST render carries their identity layers. Both are read from
    // the same body fields `resolveFleet` / `syncLaunchModeToRegistry` consume below: a fresh
    // `--fleet-name` leads, a `--fleet` slug joins as member unless `--fleet-role` says
    // otherwise; `--mode=drain|grade|test` ⇒ auto + named mode, `--auto` ⇒ auto, and a fleet MEMBER is
    // always AUTO (`ensureLaunchedWakeAuto` registers it). Resolution happens after this
    // build, and a requested fleet that fails to resolve refuses the launch outright (the
    // `fleetRequested` guard), so the render can never outlive a membership that did not
    // happen — and the registry write that follows is the same set, so the kickoff prose
    // and the live `agent_modes` rows agree from turn 1 (EI-11110 / WI-5976).
    const launchFleetRole = body.fleet_name?.trim() ? 'leader' : body.fleet?.trim() ? body.fleet_role?.trim() || 'member' : null;
    const launchNamedMode = body.mode?.trim() || null;
    const launchDrain = launchNamedMode === 'drain';
    const launchAuto = body.auto === true || Boolean(launchNamedMode) || launchFleetRole === 'member';
    const launchModes: string[] | null = goalBootstrapSubject
      ? ['goal', 'auto', 'ideate']
      : launchAuto || launchNamedMode
        ? [...(launchAuto ? ['auto'] : []), ...(launchNamedMode ? [launchNamedMode] : [])]
        : null;
    let spec;
    try {
      spec = await buildLaunchSpec({
        kind: 'su',
        agent,
        workspaceId: workspace,
        operatorBaseUrl: new URL(req.url).origin,
        harnessSlug,
        profile,
        contextSize,
        personaTier,
        model,
        planSlug,
        planTitle,
        planNow,
        // EI-996: null for a plain su launch ⇒ byte-identical prompt.
        roleAddendum,
        roleId: suRoleRaw ?? 'su',
        stack: body.stack?.map((ref) => ref.trim()) ?? null,
        fleetRole: launchFleetRole,
        modes: launchModes,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'su launch spec build failed' }, 400);
    }

    const launchContextPath = body.launch_context?.trim() || null;
    let launchContextText = '';
    if (launchContextPath) {
      try {
        const budgetModule = await import('../../../model-context-budget.mjs');
        launchContextText = budgetModule.readLaunchContextText(launchContextPath);
      } catch (e: any) {
        return jsonRes({ status: 'error', error: `read launch_context: ${e?.message}` }, 400);
      }
    }

    let sessionPortContext: {
      row: import('../../../session-port/store').SessionPortRow;
      seed: string;
      requestHash: string;
    } | null = null;
    const portToken = body.session_port_token?.trim() || null;
    const portProtocol = body.session_port_protocol;
    const portTransform = body.session_port_transform_version;
    if (portToken || portProtocol != null || portTransform != null) {
      if (!portToken || portProtocol !== SESSION_PORT_PROTOCOL_VERSION || portTransform !== SESSION_PORT_TRANSFORM_VERSION) {
        return jsonRes({
          status: 'error',
          error: `unsupported/incomplete session-port handshake; launcher and operator must support protocol/transform ${SESSION_PORT_PROTOCOL_VERSION}/${SESSION_PORT_TRANSFORM_VERSION}`,
          supportedSessionPortProtocols: [SESSION_PORT_PROTOCOL_VERSION],
          supportedSessionPortTransforms: [SESSION_PORT_TRANSFORM_VERSION],
        }, 426);
      }
      if (body.fleet?.trim() || body.fleet_name?.trim() || body.seat?.trim() || body.auto === true || body.mode?.trim()) {
        return jsonRes({
          status: 'error',
          error: 'session ports continue the source coordination identity; new fleet/seat/auto/mode authority cannot be requested at the port boundary',
        }, 409);
      }
      const [artifact, store, budgetModule, renderer, service] = await Promise.all([
        import('../../../session-port/artifact'),
        import('../../../session-port/store'),
        import('../../../model-context-budget.mjs'),
        import('../../../session-port/render'),
        import('../../../session-port/service'),
      ]);
      const parsed = artifact.parsePortToken(portToken);
      if (!parsed) return jsonRes({ status: 'error', error: 'invalid session-port preparation token' }, 401);
      const row = await store.getSessionPort(parsed.portId, workspace);
      if (!row) return jsonRes({ status: 'error', error: 'session-port preparation not found in this workspace' }, 404);
      if (bootstrapLedgerKey !== store.sessionPortBootstrapLedgerKey(row.id)) {
        return jsonRes(
          {
            status: 'error',
            error: `session-port protocol ${SESSION_PORT_PROTOCOL_VERSION} requires bootstrap_idempotency_key=session-port:${row.id}`,
          },
          409,
        );
      }
      const summary = row.metadata.summary as SessionPortContractSummary | undefined;
      if (
        row.protocolVersion !== SESSION_PORT_PROTOCOL_VERSION ||
        summary?.versions.transform !== SESSION_PORT_TRANSFORM_VERSION
      ) {
        return jsonRes(
          {
            status: 'error',
            error: 'session port is version-skewed; prepare again with the current launcher/operator',
          },
          409,
        );
      }
      if (row.targetBackend !== agent || (row.targetModel ?? null) !== (model ?? null)) {
        return jsonRes({
          status: 'error',
          error: `prepared target ${row.targetBackend}/${row.targetModel ?? 'default'} does not match bootstrap ${agent}/${model ?? 'default'}`,
        }, 409);
      }
      const expectedAccount = typeof summary?.target?.account === 'string' ? summary.target.account : 'default';
      const requestedAccount = body.account?.trim() || 'default';
      const launchContextHash = createHash('sha256').update(launchContextText).digest('hex');
      if (
        requestedAccount !== expectedAccount ||
        summary?.target?.contextSize !== contextSize ||
        summary?.target?.launchContextHash !== launchContextHash ||
        summary?.source?.cwd !== cwd ||
        (summary?.source?.planSlug ?? null) !== planSlug
      ) {
        return jsonRes(
          {
            status: 'error',
            error:
              'session-port bootstrap inputs differ from the immutable prepared request; inspect and prepare again',
          },
          409,
        );
      }
      const sourceCoordOwnerId =
        typeof row.metadata.sourceCoordOwnerId === 'string' ? row.metadata.sourceCoordOwnerId.trim() : '';
      const requestedOwnerId = body.owner_id?.trim() || '';
      if (!sourceCoordOwnerId || requestedOwnerId !== sourceCoordOwnerId) {
        return jsonRes(
          {
            status: 'error',
            error: sourceCoordOwnerId
              ? `session port must continue source coordination identity ${sourceCoordOwnerId}; got ${requestedOwnerId || 'none'}`
              : 'prepared session port is missing its source coordination identity; inspect again with the current launcher/operator',
          },
          409,
        );
      }
      const requestHash = service.deriveSessionPortBootstrapRequestHash({
        portId: row.id,
        logicalRequestHash: row.idempotencyKey,
        workspaceId: workspace,
        sourceAdvSessionId: row.sourceAdvSessionId,
        ownerId: sourceCoordOwnerId,
        target: {
          ...summary.target,
          backend: row.targetBackend === 'omp' ? 'omp' : 'codex',
        },
        cwd,
        planSlug,
      });
      if (row.status !== 'prepared') {
        if (!artifact.verifyPortToken(portToken, row.tokenHash)) {
          return jsonRes({ status: 'error', error: 'invalid session-port preparation token' }, 401);
        }
        const disposition = await store.readSessionPortBootstrapDisposition({
          portId: row.id,
          workspaceId: workspace,
          requestHash,
        });
        if (disposition.status === 'replay') {
          return jsonRes({ ...disposition.receipt, bootstrapDeduped: true });
        }
        if (disposition.status === 'terminal') {
          return jsonRes(
            {
              status: 'error',
              error: `session-port attempt is ${disposition.port.status}; prepare again to create a linked retry`,
            },
            409,
          );
        }
        return jsonRes(
          {
            status: 'error',
            error: 'bootstrap_in_progress',
            detail: `session-port target ${disposition.targetAdvSessionId} is reserved; retry the exact request`,
            retryAfterSec: 1,
          },
          409,
        );
      }
      let seed: string;
      try {
        seed = await artifact.readSessionPortArtifact({
          token: portToken,
          expectedTokenHash: row.tokenHash,
          expectedPath: row.artifactPath,
          expiresAt: row.expiresAt,
        });
      } catch (error) {
        return jsonRes({ status: 'error', error: error instanceof Error ? error.message : String(error) }, 401);
      }
      if (!renderer.verifySessionPortSeed(seed, row.renderedHash)) {
        return jsonRes({ status: 'error', error: 'session-port artifact marker/hash mismatch' }, 409);
      }
      const previewBudget = budgetModule.buildContextBudget({
        agent,
        model,
        contextSize,
        promptText: agent === 'codex'
          ? budgetModule.appendCodexLaunchContextPrompt(spec.promptText, launchContextText)
          : spec.promptText,
        additionalPromptText: agent === 'codex' ? '' : launchContextText,
        home: homedir(),
      });
      const estimatedTokens = Number(row.metadata.estimatedTokens ?? NaN);
      if (!Number.isFinite(estimatedTokens) || estimatedTokens > previewBudget.availableInputTokens) {
        return jsonRes({
          status: 'error',
          error: `prepared session port no longer fits the target launch budget (${estimatedTokens} > ${previewBudget.availableInputTokens}); inspect again`,
        }, 409);
      }
      sessionPortContext = { row, seed, requestHash };
    }

    // WI-41363: claim before the first session/fleet/account write. A replay
    // after the proxy's upstream-silent 502 either receives the completed
    // response verbatim or a typed, retryable in-progress result; it never
    // mints a second session. The existing agent-launch ledger is the one
    // durable idempotency surface for every launch path.
    let bootstrapClaimWon = false;
    let bootstrapCompleted = false;
    // EI-21365235532676472 recurrence: the bootstrap route records/adopts its
    // adv_sessions row BEFORE several later fallible artifact/presence writes.
    // If one of those throws, a same-key client replay is safe only after that
    // partial row is terminal. Keep the exact row id outside the inner try so
    // finally can close it before releasing the replay claim.
    let incompleteBootstrapSessionId: number | null = null;
    if (bootstrapLedgerKey && !sessionPortContext) {
      const claim = await claimAgentLaunch({
        workspaceId: workspace,
        idempotencyKey: bootstrapLedgerKey,
        launchedBy: body.launched_by?.trim() || body.owner_id?.trim() || null,
      });
      if (!claim.won) {
        const prior = claim.priorSummary;
        if (prior?.status === 'ok') {
          return jsonRes({ ...(prior as unknown as BootstrapSuResult), bootstrapDeduped: true });
        }
        return jsonRes(
          {
            status: 'error',
            error: 'bootstrap_in_progress',
            detail: 'the first request still owns this bootstrap idempotency key; retry with the same key',
            retryAfterSec: 1,
          },
          409,
        );
      }
      bootstrapClaimWon = true;
    }

    try {
    // Per-session coord/lock owner (P-022). Replaces the wrapper's SID
    // minting: claude's user-level papercusp-su url env-expands ${PAPERCUSP_SID}
    // and the lock hooks read the same var, so a session's interactive calls
    // and its hooks share ONE owner — and two concurrent psu sessions get
    // distinct owners (the collapse the per-session id fixes). Minted BEFORE the
    // adv_sessions row so it's recorded as coord_owner_id — the live-roster join
    // key to coord_presence.owner_id (adv-sessions-live-roster P-001).
    // WI-5002/EI-13277: a programmatic spawner may PRE-PIN the owner (`psu
    // --owner-id=…`) so state it keyed pre-spawn (a session doors override, a
    // transcript read) binds to the session that actually runs. Malformed ids
    // and ids already live on an un-ended session are refused loudly — a
    // silent fallback to minting would re-create exactly the split-identity
    // bug the flag exists to fix.
    // WI-37743: the id of our own launcher's starting row, when it wrote one —
    // this session's row, to COMPLETE below rather than duplicate.
    let adoptableStartingRowId: number | null = null;
    const requestedSid = body.owner_id?.trim() || null;
    if (sessionPortContext) {
        const sourceCoordOwnerId =
          typeof sessionPortContext.row.metadata.sourceCoordOwnerId === 'string'
        ? sessionPortContext.row.metadata.sourceCoordOwnerId.trim()
        : '';
      if (!sourceCoordOwnerId || requestedSid !== sourceCoordOwnerId) {
        return jsonRes(
          {
            status: 'error',
            error: sourceCoordOwnerId
              ? `session port must continue source coordination identity ${sourceCoordOwnerId}; got ${requestedSid ?? 'none'}`
              : 'prepared session port is missing its source coordination identity; inspect again with the current launcher/operator',
          },
          409,
        );
      }
    }
    if (requestedSid != null) {
      if (!/^su-[A-Za-z0-9][A-Za-z0-9._-]{5,118}$/.test(requestedSid)) {
        return jsonRes(
          {
            status: 'error',
            error: `owner_id must match su-<slug> (6-119 chars of [A-Za-z0-9._-]); got ${requestedSid.slice(0, 40)}`,
          },
          400,
        );
      }
      const { sql } = getOrgPg();
      // EI-21417550055038906: a teardown that died mid-write leaves a HALF-TERMINAL
      // tuple (ended_by recorded, ended_at NULL). The freshness query below filters
      // only `ended_at IS NULL`, so that ghost read as a live binding and 409'd the
      // owner's OWN cold-carry successor forever (row 18422: ended_by='signal',
      // ended_at NULL). Stamp the missing timestamp first — the repair is narrow +
      // idempotent (fills only the missing ended_at, never overwrites a terminal
      // tuple), so a repaired ghost simply drops out of the query.
      await repairStaleAdvSessionTerminalMarkers(requestedSid);
        const live = await sql<Array<{ id: string; display: string | null; has_session: boolean; launched: boolean }>>`
        SELECT id::text, display, (session_id IS NOT NULL) AS has_session,
               (launched_at IS NOT NULL) AS launched
          FROM harness_shared.adv_sessions
         WHERE coord_owner_id = ${requestedSid} AND ended_at IS NULL
         ORDER BY id DESC
      `;
      // WI-37743: "fresh" must mean "not already RUNNING as someone else", not
      // "has no row at all". The spawner that pre-pinned this id also writes a
      // `display='terminal'` STARTING row for it (WI-6376) so the board can render
      // the session during its boot window — so by the time psu gets here, its own
      // launcher has usually already created a live row bound to this id. Treating
      // that as a conflict refused every HUD "+ New session" launch: psu exited 1,
      // and because the terminal one-liner is `exec psu`, that exit closed the
      // window, which surfaced as "its terminal closed before the session came
      // online" (owner-reported 2026-08-10).
      //
      // A precursor is recognised NARROWLY — the launcher's own terminal
      // starting shape, or a workbench row PUI already claimed (`launched_at`
      // set), still un-ended and NOT yet carrying a session id. Anything else
      // (including an unclaimed workbench row, a real running session, or a
      // starting row that already registered) is the split-identity case
      // WI-5002/EI-13277 added this guard for, and is still refused loudly.
      //
      // Classified by VALUE in a single pass (classifyPrePinnedOwnerRows) rather
      // than by re-identifying rows across two traversals of the query result — see
      // that module for why the previous filter/includes shape was a latent
      // reclassify-every-precursor-as-a-conflict bug rather than a style question.
      // EI-21442511412659661: use the shared liveness oracle rather than a
      // bootstrap-local pid/pty interpretation. Hydration is per-owner because
      // this route starts one pre-pinned owner at a time. The read is fail-soft:
      // an oracle failure is indistinguishable from an unknown verdict here and
      // must keep the binding blocking, never authorise a reclaim.
        const oracleSessionState = await resolveSessionStates([{ ownerId: requestedSid }], { hydratePerId: true })
        .then((verdicts) => verdicts.get(requestedSid)?.sessionState)
        .catch(() => undefined);
      // Only the oracle's confirmed terminal states may reclaim. In particular,
      // recorded/live/unknown (and every other non-terminal state) remain a
      // blocking conflict; missing oracle evidence is not proof of death.
      const liveness = mapPrePinnedOwnerSessionState(oracleSessionState);
      const { precursors, reclaimableConflicts, conflicts } = classifyPrePinnedOwnerRows(
        live.map((row) => ({ ...row, liveness })),
      );
      if (conflicts.length > 0) {
        // Carry WHY each live row failed the precursor test. This refusal is
        // launch-blocking and reaches the owner (psu prints it; since WI-37841 it
        // lands in ~/.papercusp/psu-launch-logs/<owner>.log), and naming only an id
        // cost a full forensic session on WI-37858 — by the time the row was read
        // back it satisfied the predicate, leaving no way to tell a genuine
        // split-identity conflict from a misclassified precursor.
        return jsonRes(
          {
            status: 'error',
            error: `owner_id ${requestedSid} is already bound to live adv session ${conflicts[0].id} — pre-pinned owners must be fresh [live rows: ${describePrePinnedConflicts(conflicts)}]`,
          },
          409,
        );
      }
      // EI-21442511412659661: reclaimableConflicts carry the shared oracle's POSITIVE
      // terminal verdict (`ended` or `suspect`). End those stranded bindings so the
      // documented fresh-successor recovery path can run instead of 409-ing forever.
      // 'reconciler' because THIS launch noticed the terminal state; exit_code stays
      // null because we observed neither a voluntary exit nor a signal.
      // markAdvSessionEnded is idempotent — it stamps only an unset ended_at — so a
      // concurrent genuine teardown cannot be double-written.
      for (const stranded of reclaimableConflicts) {
        await markAdvSessionEnded(Number(stranded.id), null, 'reconciler');
      }
      // Newest wins: a retried launch can leave an older precursor behind, and the
      // one this psu belongs to is the most recent. Older ones are left alone —
      // the dead-launch reconciler already stamps them.
      adoptableStartingRowId = precursors.length > 0 ? Number(precursors[0].id) : null;
    }
    const sid = requestedSid ?? `su-${randomUUID()}`;

    // The agent's NATIVE session id. claude lets us FORCE it (`--session-id`),
    // so we mint it here, record it, and the launcher passes it through — that's
    // the only way `psu --resume <native-uuid>` can later correlate this exact
    // session back to its adv row (without it, resume-by-uuid falls through to
    // the false "not started by psu" path). omp's native handle is the
    // omp_thread_id (linked post-launch); codex resumes via its per-session
    // CODEX_HOME and can't have its rollout id forced — so both stay null.
    const nativeSessionId = backendFeatureGuard(agent, 'forced-native-session-id').supported ? randomUUID() : null;

    // launch-path-argv-reconstruction (WI-1343): the exact `psu …` invocation that
    // launched this session — recorded on adv_sessions.launch_argv so a killed batch
    // (e.g. a 14-agent fleet) can be reconstructed. The launcher sends the literal argv
    // (normalizeLaunchArgv); a caller that omits it falls back to a server-side
    // reconstruction from the resolved fields. Before this the column was always NULL.
    const launchArgv =
      normalizedLaunchArgv ??
      reconstructPsuLaunchArgv({
        agent,
        model,
        modelSource,
        headless,
        harnessSlug,
        planSlug,
        profile,
        contextSize,
        account: body.account?.trim() || null,
        fleet: body.fleet?.trim() || body.fleet_name?.trim() || null,
      });

    // Resolve account routing BEFORE fleet creation, seat consumption, or the
    // adv_sessions row. An explicit auto/pin route is a contract: if it cannot be
    // honored, reject with no ghost session and no side effects instead of silently
    // launching on the default system credential.
    const accountPin = await resolveAccountPin(workspace, body.account, agent, sid, true, model);
    if (accountPin.error) {
      return jsonRes({ status: 'error', error: accountPin.error }, 409);
    }
    if (sessionPortContext) {
      const summary = sessionPortContext.row.metadata.summary as SessionPortContractSummary | undefined;
      const expectedAccount = typeof summary?.target?.account === 'string' ? summary.target.account : 'default';
      const actualAccount = accountPin.accountId ?? (accountPin.gatewayAuto ? 'auto' : 'default');
      if (actualAccount !== expectedAccount) {
          return jsonRes(
            {
          status: 'error',
          error: `prepared target account ${expectedAccount} did not resolve exactly at bootstrap (got ${actualAccount}); no fallback allowed`,
            },
            409,
          );
      }
    }

    // named-su-agent-fleets P-006: resolve the chosen fleet (create-on-new-name +
    // membership env). sid is this session's coord owner id → the fleet's owner +
    // leader when it creates a new fleet (D-002).
    //
    // WI-1408 (fleet-join-startup-assertion): resolved + hard-asserted HERE, BEFORE
    // recordAdvSession/armInboxWake below, so a launch that explicitly asked to
    // join/create a fleet (`--fleet=<slug>` / a new fleet name) never leaves behind a
    // "ghost" adv_sessions row + an armed inbox-wake for a session that's about to be
    // rejected. A resolution hiccup (unknown slug, transient DB error) must never
    // silently degrade to an UNFLEETED member either — that's exactly the "colour-only,
    // membership forgotten" ghost the fleet tooling exists to prevent (a member invisible
    // to fleet:assignments despite the operator having asked for a named fleet). Fail
    // LOUD here, before ANY bookkeeping, instead of fail-soft + a notice nobody reads.
    const fleetPin = await resolveFleet(workspace, {
      fleet: body.fleet,
      fleetRole: body.fleet_role,
      fleetName: body.fleet_name,
      fleetScheme: body.fleet_scheme,
      ownerId: sid,
    });
    const fleetRequested = Boolean(body.fleet?.trim() || body.fleet_name?.trim());
    if (fleetRequested && !fleetPin.fleetSlug) {
      return jsonRes(
        {
          status: 'error',
          error: `fleet join failed: ${fleetPin.notice ?? 'unknown reason'} — refusing to launch an unfleeted member when a fleet was explicitly requested.`,
        },
        409,
      );
    }

    // WI-1893 (cluster-safe fleet stamp): append the DURABLE membership fact NOW —
    // before any bookkeeping (recordAdvSession/armInboxWake), same no-ghost ordering
    // as the WI-1408 guard above. Replaces the in-memory setPendingFleet placement
    // (WI-1343), which lived in ONE cluster worker and was lost when the member's
    // first presence write landed on another — see stampFleetMembershipAtBoot.
    if (fleetPin.fleetSlug) {
      const stampErr = await stampFleetMembershipAtBoot({
        workspaceId: workspace,
        ownerId: sid,
        ownerLabel: body.label?.trim() || null,
        fleetSlug: fleetPin.fleetSlug,
        fleetRole: fleetPin.fleetRole,
      });
      if (stampErr) {
        return jsonRes(
          {
            status: 'error',
            error: `fleet membership stamp failed: ${stampErr} — refusing to launch a member that would be invisible to its fleet (WI-1893).`,
          },
          409,
        );
      }
    }

    // agent-allocation P-005 (launch-from-seats): record the seat consumption NOW —
    // same no-ghost ordering as the WI-1893 fleet stamp above (before any
    // bookkeeping), and the boot-time CAP backstop: consumeSeatAtBoot's atomic
    // conditional insert refuses the over-cap member even when concurrent launches
    // raced past the fleet:launch-on-plan gate (the P-006 "N+1th spawn refused").
    const seatRef = body.seat?.trim() || null;
    if (seatRef) {
      if (!fleetPin.fleetSlug) {
        return jsonRes(
          {
            status: 'error',
            error:
              '`--seat` requires a fleet: a seat is delegated TO a fleet (agent-allocation P-005) — pass `--fleet=<slug>` with it.',
          },
          409,
        );
      }
      const { consumeSeatAtBoot } = await import('../../../fleet/seat-accounting');
      const seatRes = await consumeSeatAtBoot({
        workspaceId: workspace,
        fleetSlug: fleetPin.fleetSlug,
        seatRef,
        ownerId: sid,
      });
      if (!seatRes.ok) {
        return jsonRes(
          {
            status: 'error',
            error: `seat consumption refused [${seatRes.refusal.code}]: ${seatRes.refusal.detail}`,
          },
          409,
        );
      }
    }

      // Every identity-bearing path must use the FINAL adv_sessions id. A port
      // therefore reserves its hidden target row and binds prepared -> pending in
      // one transaction before any prompt/home file is materialized.
    let sessionId: number | null = null;
      if (sessionPortContext) {
        const store = await import('../../../session-port/store');
        const reservation = await store.reserveSessionPortTarget({
          portId: sessionPortContext.row.id,
          workspaceId: workspace,
          requestHash: sessionPortContext.requestHash,
          target: {
            planSlug,
            agent,
            mode: agent === 'omp' ? 'omp' : 'console',
            cwd,
            label: body.label?.trim() || null,
            coordOwnerId: sid,
            nativeSessionId,
            launchArgv,
            portMetadata: {
              protocolVersion: sessionPortContext.row.protocolVersion,
              sourceBackend: sessionPortContext.row.sourceBackend,
              targetBackend: sessionPortContext.row.targetBackend,
              targetModel: sessionPortContext.row.targetModel,
              sourceHash: sessionPortContext.row.sourceHash,
              normalizedHash: sessionPortContext.row.normalizedHash,
              renderedHash: sessionPortContext.row.renderedHash,
            },
          },
        });
        if (reservation.status === 'replay') {
          return jsonRes({ ...reservation.receipt, bootstrapDeduped: true });
        }
        if (reservation.status === 'in_progress') {
          return jsonRes(
            {
              status: 'error',
              error: 'bootstrap_in_progress',
              detail: `session-port target ${reservation.targetAdvSessionId} is reserved; retry the exact request`,
              retryAfterSec: 1,
            },
            409,
          );
        }
        if (reservation.status === 'terminal') {
          return jsonRes(
            {
              status: 'error',
              error: `session-port attempt is ${reservation.port.status}; prepare again to create a linked retry`,
            },
            409,
          );
        }
        sessionPortContext.row = reservation.port;
        sessionId = reservation.targetAdvSessionId;
        incompleteBootstrapSessionId = sessionId;
      }
    if (!sessionPortContext && adoptableStartingRowId != null) {
      // WI-37743: COMPLETE our launcher's starting row instead of inserting a
      // second one beside it. Best-effort by design — if the row was stamped
      // ended (or already adopted) between the guard above and here, the adopt
      // no-ops and we fall through to the ordinary insert, so a lost race
      // degrades to the pre-fix behaviour rather than to a session with no row.
      const adopted = await adoptStartingTerminalLaunch({
        id: adoptableStartingRowId,
        sessionId: nativeSessionId,
        planSlug,
        label: body.label?.trim() || null,
        cwd,
        mode: agent === 'omp' ? 'omp' : 'console',
        launchArgv,
      });
      if (adopted) sessionId = adoptableStartingRowId;
    }
    if (!sessionPortContext && sessionId == null) {
      sessionId = await recordAdvSession({
        planSlug,
        agent,
        workspaceId: workspace,
        mode: agent === 'omp' ? 'omp' : 'console',
        cwd,
        label: body.label?.trim() || null,
        coordOwnerId: sid,
        sessionId: nativeSessionId,
        launchArgv,
      });
    }
    if (!sessionPortContext && sessionId != null) {
      incompleteBootstrapSessionId = sessionId;
    }
    if (!sessionPortContext) {
      await bindKnownAgentSessionTasks({
        workspaceId: workspace,
        coordOwnerId: sid,
        sessionId: nativeSessionId,
        source: 'bootstrap',
      });
    }
      const sessionKey = sessionId ?? `t-${randomUUID()}`;

    // WI-1343's in-memory setPendingFleet placement used to live here; replaced by the
    // durable membership-fact stamp above (WI-1893 — the map was per-cluster-worker and
    // lost placements when the member's first presence write hit another worker).

    // Fleet-launched agents start AUTONOMOUS (WI-1356): a fleet member has no human
    // at its keyboard, so `--fleet` (or an explicit `--auto`) launches it in AUTO
    // mode. The launcher sends `auto` in the body; when set we (a) inject a DURABLE
    // AUTO directive into the assembled system prompt (survives compaction) and
    // (b) prepend the same activation to the seeded kickoff so turn 1 enters AUTO.
    // Named modes enter before turn one. Unknown mode values
    // are refused loudly (a typo'd mode silently launching a plain session is the
    // failure this guards). DRAIN IMPLIES AUTO — force autoMode on.
    const modeRaw = body.mode?.trim() || null;
    if (modeRaw && modeRaw !== 'drain' && modeRaw !== 'grade' && modeRaw !== 'test') {
      return jsonRes(
        {
          status: 'error',
          error: `unknown mode '${modeRaw.slice(0, 32)}' — recognized values: drain, grade, test`,
        },
        400,
      );
    }
    const drainMode = modeRaw === 'drain';
    const autoMode = body.auto === true || Boolean(modeRaw) || Boolean(goalBootstrapSubject);

    // Normalize before either registry/fact writes or prompt assembly. The
    // shared core is the single bound for subject/instructions, so a direct
    // loopback POST cannot smuggle an unbounded scope into a child session.
    const launchMode = modeRaw
      ? normalizeLaunchMode({
          mode: modeRaw,
          subject: body.mode_subject,
          instructions: body.mode_instructions,
          ownerDirected: body.mode_owner_directed === true,
        })
      : null;

    // EI-11110 / WI-5976: keep the mode REGISTRY in sync with the AUTO/DRAIN prose
    // this launch is about to bake into the prompt (see syncLaunchModeToRegistry's
    // doc comment for the full contradiction this closes). Best-effort — logged,
    // never fails the launch.
    const modeSyncErr = goalBootstrapSubject ? null : await syncLaunchModeToRegistry({
      workspaceId: workspace,
      ownerId: sid,
      autoMode,
      drainMode,
      namedMode: launchMode?.mode ?? null,
      ...(launchMode?.subject !== null && launchMode?.subject !== undefined
        ? { subject: launchMode.subject }
        : body.mode_subject !== undefined
          ? { subject: null }
          : {}),
      ...(body.mode_instructions !== undefined ? { instructions: body.mode_instructions } : {}),
      ...(body.mode_owner_directed !== undefined ? { ownerDirected: launchMode?.ownerDirected === true } : {}),
      reason: modeRaw
        ? `launch: --mode=${modeRaw}`
        : fleetPin.fleetSlug
          ? 'fleet launch: --auto'
          : 'launch: --auto',
    });
    if (modeSyncErr) {
      if (modeRaw === 'grade' || modeRaw === 'test') {
        return jsonRes({ status: 'error', error: `verifier_mode_activation_failed: ${modeSyncErr}` }, 503);
      }
      process.stderr.write(
        `[bootstrap-su] launch-time mode-registry sync failed (non-fatal — the kickoff prose ` +
          `may now disagree with the registry until the agent self-registers via mode:set): ${modeSyncErr}\n`,
      );
    }

    /* WI-37856: repair modes this agent should already hold. The implication
       cascade fires on the WRITE that enters a mode, so an agent that entered a
       mode BEFORE that mode declared an implication keeps a mode set the
       contract says is impossible — measured 2026-08-10, when `goal` gained
       implies:['auto','ideate'] and all three already-bound GOAL agents were
       left without `ideate` (one without `auto` too, i.e. holding a GOAL
       binding in ask-first posture).
       HERE, and unconditionally, on purpose: this is the one door every su
       session passes through, and it is OUTSIDE the `autoMode` branch above
       because the agents that need repairing are exactly the ones whose launch
       flags say nothing about the modes they already hold. `implies` is a
       registry field designed to be edited, so this is not a one-off backfill —
       every future edit re-opens the identical gap.
       Cheap and safe to run every boot: each fill is INSERT … ON CONFLICT DO
       NOTHING, so the steady state writes nothing, and it can never displace a
       posture the agent or owner chose. Best-effort, like the sync above — a
       reconcile failure must never cost a launch. */
    try {
      const { reconcileImpliedModes } = await import('../../../modes/store');
      const repaired = (await reconcileImpliedModes({ workspaceId: workspace, ownerId: sid })).filter(
        (r) => r.status === 'set' || r.status === 'failed',
      );
      if (repaired.length) {
        process.stderr.write(
          `[bootstrap-su] implied-mode reconcile for ${sid}: ` +
            `${repaired.map((r) => `${r.mode}=${r.status}${r.error ? ` (${r.error})` : ''}`).join(', ')}\n`,
        );
      }
    } catch (e: any) {
      process.stderr.write(
        `[bootstrap-su] implied-mode reconcile failed (non-fatal — this agent may still be ` +
          `missing modes its mode implies): ${e?.message ?? String(e)}\n`,
      );
    }
    if (goalBootstrapSubject) {
      const problem = await awaitGoalBootstrapModes(workspace, sid, goalBootstrapSubject);
      if (problem) {
        return jsonRes({ status: 'error', code: 'goal_bootstrap_attestation_failed', error: problem }, 409);
      }
    }

    // solo-launch-provenance: identity-shaped only — refuse garbage loudly rather
    // than bake it into a system prompt / standing fact.
    const launchedByRaw = body.launched_by?.trim() || null;
    if (launchedByRaw && !/^[A-Za-z0-9._:-]{1,120}$/.test(launchedByRaw)) {
      return jsonRes(
        { status: 'error', error: `launched_by must be an owner id (got ${launchedByRaw.slice(0, 48)})` },
        400,
      );
    }
    const launchedBy = launchedByRaw;

    // The prompt OVERLAYS (codex launch-context, launcher provenance, AUTO/DRAIN
    // activation, instruction precedence) are applied together further down, once
    // the loop auto-arm outcome is known — see applySuPromptOverlays, which the
    // carry-respawn persona refresh calls too. What stays HERE is the provenance
    // SIDE EFFECT, which a re-render must never repeat.
    if (launchedBy) {
      // Assert the provenance as an owner-scoped STANDING FACT — coord:orient
      // folds owner-scope facts VERBATIM at every orient, so the agent re-learns its
      // launcher on every wake (a cold loop re-orients from nothing each wake).
      // Best-effort: a facts outage must never block a launch.
      try {
        const { assertFact } = await import('../../../agent-facts/store');
        await assertFact({
          scope: 'owner',
          scopeRef: sid,
          key: 'launch-provenance',
          body: buildLaunchProvenanceFactBody({
            launchedBy,
            planSlug,
            launchContextPath,
            fleetSlug: fleetPin.fleetSlug,
          }),
          sourceRef: 'bootstrap-su:launched-by',
          createdBy: launchedBy,
          ttlSec: 30 * 24 * 3600,
          workspaceId: workspace,
        });
      } catch (e: any) {
        process.stderr.write(`[bootstrap-su] provenance fact assert failed (non-fatal): ${e?.message}\n`);
      }

      // goal-mode-hardening-2026-08-10 P-002 / D-008: inherit the LAUNCHER's
      // goal so this session's work stamps `work_items.goal_id`, WITHOUT giving
      // it GOAL mode. Before this, only the agent RUNNING a goal stamped
      // provenance, so a goal's fleet — the sessions doing the actual work —
      // was invisible to its spend meter and its "what belongs to this goal?"
      // view.
      //
      // THIS IS THE ONE SEAM, deliberately, and it is why no `--goal=<id>` flag
      // exists. Every tool-driven psu launch already carries
      // `--launched-by=<ownerId>` (capability:terminal injects it, launch-su and
      // fleet:launch-on-plan compose it), so inheriting HERE covers every launch
      // path that can spawn an agent at all — including ones added later, which
      // a per-call-site flag would silently miss. That miss is the failure mode
      // the flag design invites: a new spawn site composes argv, forgets one
      // flag, and its descendants' work quietly leaves the goal.
      //
      // Reads the launcher's RESOLVED context, not its mode subject, so a child
      // of a child inherits too (transitivity is the resolver's property).
      try {
        const { resolveGoalContext, setInheritedGoalContext } = await import('../../../modes/goal-context');
        const inheritedGoal = await resolveGoalContext(workspace, launchedBy);
        if (inheritedGoal) {
          const wrote = await setInheritedGoalContext(workspace, sid, inheritedGoal);
          if (!wrote) {
            process.stderr.write(
              `[bootstrap-su] goal-context inherit failed for ${sid} (goal ${inheritedGoal}) — its work will not stamp goal provenance\n`,
            );
          }
        }
      } catch (e: any) {
        process.stderr.write(`[bootstrap-su] goal-context inherit failed (non-fatal): ${e?.message}\n`);
      }
    }

    // WI-2185 / EI-19965557940158384 (launched-wake-immunity): a spawned fleet
    // MEMBER, or ANY session an agent launched (fleetless or not — `launchedBy` is
    // the agent-launched-only signal, see the `launched_by` field doc above), gets a
    // per-agent `auto` wake-mode override at boot so its launcher's steering wakes
    // LAND even under a `manual` GLOBAL default (the D-005 gate). Without this, a
    // manual-default launch deadlocks: the launched agent can't receive steering, and
    // its launcher (often a weak local model, or another agent with no release
    // authority) can't release a staged wake — only the owner can. A LEADER stays
    // gated by design (the owner is assumed present for it). Scoped per-agent, so the
    // owner's global default is untouched for every session neither a member nor
    // agent-launched. Fail-soft: a write hiccup just reverts to the pre-fix inherited
    // default, never blocks the launch (a coordination-quality write, not a
    // correctness gate — unlike the WI-1893 membership stamp above).
    try {
      const { ensureLaunchedWakeAuto } = await import('../../../agent-tools/coordination/wake-mode');
      await ensureLaunchedWakeAuto(sid, { fleetRole: fleetPin.fleetRole, launchedByAgent: !!launchedBy });
    } catch {
      /* degrade to the inherited default; non-fatal */
    }

    // kickoff-prompt-absorption-2026-07-17 P-001: auto-arm a plan-bound fleet
    // MEMBER's engine loop server-side, right here — the moment its fleet
    // membership is durably registered (stampFleetMembershipAtBoot, above) —
    // instead of leaving it to AUTO_MODE_DIRECTIVE's in-prompt "you must self-arm"
    // instruction alone. Idempotent (never clobbers an existing loop); a silent
    // no-op for a leader, an unplanned session, or a non-auto launch. Best-effort:
    // never fails the boot — the kickoff instruction remains the fallback path.
    // Runs BEFORE the AUTO-directive injection below (P-004): the directive text
    // depends on whether the arm actually took.
    let loopAutoArm: { armed: boolean; reason: string; loopName?: string } | null = null;
    if (autoMode && fleetPin.fleetSlug && harnessSlug) {
      try {
        const { autoArmFleetMemberLoop } = await import('../../../harness/routines/loop');
        loopAutoArm = await autoArmFleetMemberLoop({
          workspaceId: workspace,
          ownerId: sid,
          harnessSlug,
          planSlug,
          fleetSlug: fleetPin.fleetSlug,
          fleetRole: fleetPin.fleetRole,
          carry,
        });
      } catch (e: any) {
        loopAutoArm = { armed: false, reason: `error: ${e?.message ?? e}` };
      }
    }

    // fleet-auto-mode (WI-1356): the durable AUTO/DRAIN directive baked into the
    // assembled system prompt so it survives compaction. promptText is the single
    // source for every backend's launch context (claude/omp launch-context file +
    // codex AGENTS.md), so injecting here covers all three. P-004: the AUTO variant
    // reflects the auto-arm outcome — an armed loop swaps the "MUST ARM" clause for
    // the one-line "already armed" notice.
    const loopArmed = loopAutoArm?.armed === true;
    const modeSection = composeModePromptSection({ autoMode, drainMode, loopArmed });

    // P-022: compile the ACTUAL launch-time mode/route/scope precedence into a
    // machine-readable trace. This does not delete the generic conditional
    // playbook clauses (a later mode transition may need them); it explicitly
    // marks the rules that are suppressed NOW and tells the agent how to full-
    // resync on any watermark/control change.
    const instructionRuntime: InstructionRuntimeContext = await resolveSuInstructionRuntime({
      ownerId: sid,
      autoMode,
      drainMode,
      fleet: fleetPin.fleetSlug ? { slug: fleetPin.fleetSlug, role: fleetPin.fleetRole } : null,
      workspaceId: workspace,
      harnessSlug,
      planSlug,
    });

    // Apply every per-launch overlay in the ONE canonical order, and audit the
    // ACTUAL final prompt rather than the base launch spec — the overlays are
    // exactly where generated-rule conflicts get introduced. Launch stays fail-open
    // because duplicate prose is a cleanup signal, while blocking conflicts are
    // refused below. The carry-respawn persona refresh calls this same function, so
    // a re-rendered prompt cannot drift from a freshly-launched one.
    const overlaid = await applySuPromptOverlays({
      basePromptText: spec.promptText,
      agent,
      launchContextText: launchContextPath ? launchContextText : '',
      launchedBy,
      modeSection,
      instructionRuntime,
    });
    let promptText = overlaid.promptText;
    let instructionLint = overlaid.instructionLint;
    if (
      instructionLint.conflicts.length > 0 ||
      instructionLint.staleRules.length > 0 ||
      instructionLint.unconditionalPostCompactionRecovery.length > 0
    ) {
      process.stderr.write(
        `[bootstrap-su] instruction lint: ${instructionLint.conflicts.length} conflict(s), ` +
          `${instructionLint.staleRules.length} stale rule(s), ` +
          `${instructionLint.unconditionalPostCompactionRecovery.length} unconditional post-compaction recovery directive(s)\n`,
      );
    }
    const blockingInstructions = blockingInstructionConflicts(instructionLint);
    if (blockingInstructions.length > 0) {
      const onlyFileLocks = blockingInstructions.every((entry) => entry.key === 'file-locking');
      return jsonRes(
        {
          status: 'error',
          error: onlyFileLocks
            ? 'compiled instructions contain contradictory file-lock modes; launch refused'
            : 'compiled instructions contain a blocking instruction-contract violation; launch refused',
          instructionLint,
        },
        500,
      );
    }

    // P-008/D-028/D-030: compile the ACTUAL final bytes (after every launch
    // overlay) through the immutable P-038 boundary. The precedence watermark is
    // the separately versioned mutable state revision; both ids are carried by
    // every client in the response/env beside the exact prompt it consumes.
    const precedence = buildInstructionPrecedenceTrace(instructionRuntime);
    let launchArtifact;
    try {
      launchArtifact = await compileLaunchSpecificationArtifact({
        promptText,
        promptFile: spec.promptFile,
        cwd,
        workspaceId: workspace,
        harnessSlug,
        role: suRoleRaw ?? 'su',
        stack: spec.stack,
        expectedModelDefault: identityModelDefault,
        compositionRootId: body.stack?.length === 1 && body.stack[0]?.startsWith('composition:')
          ? body.stack[0].slice('composition:'.length) : null,
        stateRevision: precedence.watermark,
        state: {
          schemaVersion: 1,
          principal: { kind: 'su', role: suRoleRaw ?? 'su', profile },
          policy: { mcp: 'superuser', contextSize, personaTier: spec.personaTier ?? null },
          instructionPrecedence: precedence,
        },
      });
      if (body.selected_identity_revision) {
        const selectedId = body.stack![0]!.split(':').slice(1).join(':');
        const pinned = launchArtifact.specificationArtifact.inputs.filter((entry) =>
          entry.kind === 'blueprint-layer');
        let revisionMatches = pinned.some((entry) => entry.ref === selectedId &&
          entry.contentHash === body.selected_identity_revision);
        if (body.stack![0]!.startsWith('composition:')) {
          const { resolveNamedIdentityCompositionSelection } = await import('../../../agent-identities/source');
          const selected = await resolveNamedIdentityCompositionSelection(selectedId, cwd);
          revisionMatches = selected.sourceRevision === body.selected_identity_revision &&
            selected.layers.every((layer) => pinned.some((entry) =>
              entry.ref === layer.id && entry.contentHash === layer.contentHash));
        }
        if (!selectedId || !revisionMatches) {
          throw new Error('selected identity source revision changed after picker selection');
        }
      }
      if (launchArtifact.resourceArtifacts.length > 0) {
        await provisionLaunchIdentityResources(launchArtifact, getOrgPg().sql, { ownerId: sid });
      }
      promptText = launchArtifact.promptText;
    } catch (e: any) {
      return jsonRes({ status: 'error', error: `compile su launch artifact: ${e?.message ?? e}` }, 500);
    }

    // Materialize the launch artifacts. codex (no --mcp-config/-prompt flags)
    // gets a per-session CODEX_HOME (P-030); claude/omp get a launch-context
    // prompt file and rely on their USER-LEVEL papercusp-su MCP (it survives
    // a raw launch — no per-launch .mcp.json needed for su).
    let promptFile = '';
    let codexHome: string | null = null;
    try {
      if (agent === 'codex') {
        // D-006: the superuser bearer is baked into the home's config.toml
        // (codex 0.135's bearer_token_env_var doesn't deliver for HTTP MCP).
        // Read it server-side — it never transits the bootstrap HTTP response.
        const ch = writeSuCodexHome({
          sessionKey,
          mcpUrl: spec.mcpUrl,
          promptText,
          sid,
          model,
          token: readSuperuserToken(),
          codexGatewayAccountId: accountPin.provider === 'codex' ? accountPin.accountId : null,
          // WI-3645: explicit-auto → the UNPINNED gateway provider block (header omitted;
          // the gateway auto-selects). False whenever a pin resolved or routing is off.
          codexGatewayAuto: accountPin.provider === 'codex' && !!accountPin.gatewayAuto,
          codexGatewayPriority: accountPin.provider === 'codex' ? 'su' : null,
          // Seed launch-dir trust so a fresh CODEX_HOME doesn't block at codex's
          // "Do you trust this directory?" boot prompt (an su launch is trusted).
          trustDir: cwd,
          instructionRuntime,
          // EI-11366: refuse to silently destroy a DIFFERENT sid's still-live
          // Codex home (the identity-split incident this bug reported) —
          // findLiveHost is the same self-validating (pid-alive + socket-exists
          // + cmdline-verified) liveness oracle the wake-executor injects
          // through, so "live" here means a real running psu-pty host, not
          // just a DB row.
          isOwnerLive: (priorSid: string) => findLiveHost(priorSid) != null,
        });
        codexHome = ch.codexHome;
        promptFile = ch.agentsPath; // AGENTS.md — diagnostics
        instructionLint = ch.instructionLint ?? lintInstructionText(promptText, 20, instructionRuntime);
        const codexBlockingInstructions = blockingInstructionConflicts(instructionLint);
        if (codexBlockingInstructions.length > 0) {
          const onlyFileLocks = codexBlockingInstructions.every((entry) => entry.key === 'file-locking');
          return jsonRes(
            {
              status: 'error',
              error: onlyFileLocks
                ? 'runtime-resolved Codex instructions contain contradictory file-lock modes; launch refused'
                : 'runtime-resolved Codex instructions contain a blocking instruction-contract violation; launch refused',
              instructionLint,
            },
            500,
          );
        }
      } else {
        promptFile = launchContextPathFor(sessionKey);
        mkdirSync(launchContextDir(), { recursive: true });
        writeFileSync(promptFile, promptText, { mode: 0o600 });
      }
    } catch (e: any) {
      return jsonRes({ status: 'error', error: `write su launch artifacts: ${e?.message}` }, 500);
    }

    // Materialize saved prompts so the session starts with the workspace's
    // `/name` commands (+ the harness's, when this su session is harness-
    // scoped) available in this client (plan saved-prompts-cross-client).
    // Codex needs them in its ephemeral home; claude/omp read .claude/commands.
    // Best-effort — never block a launch.
    try {
      if (agent === 'codex' && codexHome) {
        await materializeCodexPrompts(codexHome, workspace, harnessSlug);
        // Slash exposure (slash-exposure-tool-catalog-2026-06-12 P-009):
        // Codex doesn't surface MCP prompts as slash commands, so the
        // session-visible tool catalog is materialized as prompt FILES.
        // An su session runs the operator-role catalog.
        const r = await emitCodexSlashToolPrompts(codexHome, 'operator' as never);
        process.stderr.write(
          `[bootstrap-su] slash tool prompts: ${r.written} written, ${r.pruned} pruned in ${Math.round(r.ms)}ms\n`,
        );
      } else {
        await materializeWorkspacePrompts(workspace);
        if (harnessSlug) await materializeHarnessPrompts(workspace, harnessSlug);
      }
    } catch (e: any) {
      // stderr (not console.*) so the vitest fail-on-console guard stays green.
      process.stderr.write(`[bootstrap-su] saved-prompts materialize failed (non-fatal): ${e?.message}\n`);
    }

    // omp loads the coordination extension via -e for lock enforcement.
    const coordExt = resolveInstallPaths(homedir()).extensionPath;
    const coordExtPath = existsSync(coordExt) ? coordExt : null;

    // EI-155: an interactive claude session gets a per-session, transcript-
    // isolated CLAUDE_CONFIG_DIR (keyed by sid via the shared helper, so the
    // wake-executor resume leg resolves the SAME dir). It is a symlink mirror of
    // ~/.claude with only `projects/` isolated — the user-level papercusp-su MCP,
    // the lock/coord hooks, plugins, and onboarding/trust all carry through (a
    // creds-only dir like the bee path would strip all of those — see
    // writeInteractiveClaudeConfig). codex isolates via its CODEX_HOME; omp's
    // store is its own. Best-effort: a materialize failure must not block a
    // launch (the session falls back to the shared ~/.claude, exactly as before).
    let claudeConfigDir: string | null = null;
    if (agent === 'claude') {
      try {
        // P-020: a fleet-tier member gets the pruned plugin/MCP surface
        // (github/cloudflare/firecrawl plugins + the playwright mcpServer dropped).
        claudeConfigDir = writeInteractiveClaudeConfig({
          sid,
          prunePlugins: spec.personaTier === 'fleet',
          // WI-3280: park the playbook so the SessionStart recovery hook can
          // re-deliver it if claude's self-re-exec drops the launch argv.
          recovery: { playbookPath: promptFile || null, nativeSessionId },
          // EI-16574: pre-trust this launch's cwd so a brand-new project
          // directory (e.g. a fresh pot:create_from_repo clone, headless
          // fleet member) can't wedge forever on an external-CLAUDE.md-
          // imports / trust-dialog TTY prompt nobody is there to answer.
          cwd,
        }).configDir;
      } catch (e: any) {
        process.stderr.write(`[bootstrap-su] claude config-dir materialize failed (non-fatal): ${e?.message}\n`);
      }
    }

    // code-intelligence-routing-lsp-gitnexus-2026-08-20 P-021 (D-013): may this
    // omp session KEEP its native `lsp` builtin? Resolved HERE, not in the
    // launcher — psu-launcher.mjs is bare node and cannot import the TS flags
    // lib, so the decision resolves server-side and threads through envelopeEnv;
    // the launcher stays free of any launch-time flag read (and therefore any
    // network dependency at spawn).
    //
    // The decision itself — including the local-model TIER GATE that is what
    // makes OMP_NATIVE_LSP_BUILTIN safe to ship default-ON — lives in ONE place,
    // mayKeepOmpNativeLsp, shared with bootstrap-role. Read its header before
    // changing anything here. Fail-soft: a flag-lookup throw ⇒ off ⇒ the
    // launcher strips the builtin, byte-identical to the pre-P-021 `--no-lsp`.
    let ompNativeLsp = false;
    try {
      if (agent === 'omp') {
        const { getFlag } = await import('@papercusp/flags/server');
        const { FLAGS } = await import('@papercusp/flags');
        const { mayKeepOmpNativeLsp } = await import('../../../omp-native-lsp-gate');
        ompNativeLsp = mayKeepOmpNativeLsp({
          agent,
          model,
          flagEnabled: await getFlag(FLAGS.OMP_NATIVE_LSP_BUILTIN, workspace),
        });
      }
    } catch {
      /* flag miss ⇒ builtin stays stripped (pre-P-021 behaviour stands) */
    }

    // Revalidate the fully assembled launch prompt before minting a pending
    // target identity. The imported history remains a separate user turn.
    const { buildContextBudget } = await import('../../../model-context-budget.mjs');
    const contextBudget = buildContextBudget({
      agent,
      model,
      contextSize,
      promptText,
      additionalPromptText: agent === 'codex' ? '' : launchContextText,
      home: homedir(),
    });
    if (sessionPortContext) {
      const estimatedTokens = Number(sessionPortContext.row.metadata.estimatedTokens ?? NaN);
      if (!Number.isFinite(estimatedTokens) || estimatedTokens > contextBudget.availableInputTokens) {
          return jsonRes(
            {
          status: 'error',
          error: `session-port fit changed at bootstrap (${estimatedTokens} > ${contextBudget.availableInputTokens}); inspect again`,
            },
            409,
          );
      }
    }

      // The port target row was reserved before any identity-bearing file write.
      // It stays hidden while pending; this stage only binds known tasks and emits
      // the lifecycle projection for the already-immutable target id.
    if (sessionPortContext) {
      if (sessionId == null) {
        return jsonRes({ status: 'error', error: 'could not persist the pending session-port target row' }, 503);
      }
      await bindKnownAgentSessionTasks({
        workspaceId: workspace,
        coordOwnerId: sid,
        sessionId: nativeSessionId,
        source: 'session-port',
      });
        const summary = sessionPortContext.row.metadata.summary as SessionPortContractSummary;
        await recordSessionPortTelemetry({
          workspaceId: workspace,
          stage: 'pending',
          portId: sessionPortContext.row.id,
          sourceAdvSessionId: sessionPortContext.row.sourceAdvSessionId,
          targetAdvSessionId: sessionId,
          sourceBackend: sessionPortContext.row.sourceBackend,
          targetBackend: sessionPortContext.row.targetBackend,
          targetProvider: summary?.target?.provider ?? null,
          targetModel: sessionPortContext.row.targetModel,
          targetAccount: summary?.target?.account ?? null,
          fidelity: summary?.fidelity ?? null,
          omittedAttachments: summary?.stats?.omittedAttachments ?? null,
          unsupportedBlocks: summary?.stats?.unsupportedBlocks ?? null,
          redactions: summary?.stats?.redactions ?? null,
          summarized: summary?.summary != null,
          summaryModel: summary?.summary?.model ?? null,
          summaryPromptVersion: summary?.versions?.summaryPrompt ?? null,
          sourceHash: sessionPortContext.row.sourceHash,
          renderedHash: sessionPortContext.row.renderedHash,
          estimatedTokens: Number(sessionPortContext.row.metadata.estimatedTokens ?? null),
          protocolVersion: sessionPortContext.row.protocolVersion,
        });
    }

    // EI-21005277510954647: bootstrap is the first point that simultaneously
    // knows the stable owner id + concrete harness. Stamp pot_slug now so a
    // fleet-launched member is visible to hive-scoped coord:presence before its
    // first agent turn/orient call. The session row exists on both ordinary and
    // port paths at this point, so this cannot create a launch ghost.
    if (harnessSlug) {
      const presenceStampErr = await stampPresenceAtBoot({
        workspaceId: workspace,
        ownerId: sid,
        ownerLabel: body.label?.trim() || null,
        harnessSlug,
      });
      if (presenceStampErr) {
        process.stderr.write(
          `[bootstrap-su] presence pot-scope stamp failed (non-fatal; first coord:orient can repair it): ${presenceStampErr}\n`,
        );
      }
    }

    // The target becomes wakeable only after the tracking row/port claim exists.
    try {
      const { armInboxWake } = await import('../../../events/await/inbox-wake-arm');
      await armInboxWake({ ownerId: sid, workspaceId: workspace });
    } catch (e: any) {
      process.stderr.write(`[bootstrap-su] inbox-wake arm failed (non-fatal): ${e?.message}\n`);
    }

    // stale-prompt-render-in-live-sessions-2026-08-02 P-002: persist the RESOLVED
    // render inputs beside launch_argv so a carry-respawn can re-render this
    // session's persona from CURRENT prompt sources. Without it a respawn inherits
    // the predecessor's already-rendered file and the base persona stays pinned to
    // launch #1 forever (27 of 53 live sessions were up to 14 days stale when this
    // was measured). Written after the row exists on BOTH paths — an ordinary
    // launch records it above, a session-port target only after its claim.
    // Best-effort: a launch must never fail on this bookkeeping, and a session
    // without it simply keeps today's inherit-the-old-render behaviour.
    {
      const launchSpecRecord: SuLaunchSpecRecord = {
        v: 1,
        agent,
        workspaceId: workspace,
        harnessSlug,
        profile,
        contextSize,
        personaTier,
        model,
        ...(modelSource ? { modelSource } : {}),
        planSlug,
        launchedBy,
        autoMode,
        drainMode,
        loopArmed,
        fleet: fleetPin.fleetSlug ? { slug: fleetPin.fleetSlug, role: fleetPin.fleetRole } : null,
        stack: spec.stack,
        ...(body.selected_identity_revision && body.stack?.length === 1
          ? { selectedIdentity: { ref: body.stack[0]!, sourceRevision: body.selected_identity_revision } }
          : {}),
        specificationRevision: launchArtifact.specificationRevision,
        stateRevision: launchArtifact.stateRevision,
        principalId: launchPrincipal?.slug?.trim() || sid,
        specificationArtifact: launchArtifact.specificationArtifact,
      };
      const launchSpecRecorded = await recordSuLaunchSpec(sessionId, sid, launchSpecRecord);
      if (!launchSpecRecorded) {
        return jsonRes({ status: 'error', error: 'session launch specification receipt was not persisted' }, 500);
      }
      try {
        await requestSessionIdentityActivation({
          ownerId: sid,
          workspaceId: workspace,
          revision: {
            specificationRevision: launchArtifact.specificationRevision,
            stateRevision: launchArtifact.stateRevision,
          },
          attribution: {
            actorId: sid,
            principalId: launchSpecRecord.principalId ?? sid,
            sessionId: sid,
          },
          source: 'launch',
        });
      } catch (error) {
          return jsonRes(
            {
          status: 'error',
          error: `session identity activation receipt was not persisted: ${error instanceof Error ? error.message : String(error)}`,
            },
            500,
          );
      }
    }

    const envelopeEnv: Record<string, string> = {
      ...envelope.env,
      // P-021/D-013 — see the ompNativeLsp resolution above. Set-when-true, so
      // ABSENT is the safe reading: the launcher strips omp's native `lsp`
      // builtin unless this explicitly says it may keep it.
      ...(ompNativeLsp ? { PAPERCUSP_OMP_NATIVE_LSP: '1' } : {}),
      PAPERCUSP_AGENT: agent,
      PAPERCUSP_SID: sid,
      // Per-launch dispatch profile. claude's user-level MCP url expands
      // ${PAPERCUSP_PROFILE:-}; omp carries it via the x-papercusp-profile
      // header — without this export, --profile=power changed only the
      // playbook text while the MCP dispatcher kept gating as engineer.
      PAPERCUSP_PROFILE: profile,
      PAPERCUSP_SPECIFICATION_REVISION: launchArtifact.specificationRevision,
      PAPERCUSP_STATE_REVISION: launchArtifact.stateRevision,
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
      ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
      ...(sessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(sessionId) } : {}),
      // solo-launch-provenance: the launcher's ownerId, readable by hooks/tools.
      ...(launchedBy ? { PAPERCUSP_LAUNCHED_BY: launchedBy } : {}),
      ...(modelSource ? { PAPERCUSP_MODEL_SOURCE: modelSource } : {}),
    };

    // psu-account-chooser P-002: fold the resolved route into the envelope. For
    // Claude default this includes the force-system marker; auto/pins carry their
    // gateway route. Unavailable explicit nondefault routes were rejected above.
    Object.assign(envelopeEnv, accountPin.env);
    // named-su-agent-fleets P-006: fold the fleet membership env (PAPERCUSP_FLEET_SLUG /
    // PAPERCUSP_FLEET_ROLE) right next to the account pin — the presence-write path
    // reads those exact var names. Empty when no fleet was chosen (byte-identical).
    Object.assign(envelopeEnv, fleetPin.env);

    // pot-seat-pools-prose-ux-2026-07-18 P-007/P-013/P-014: only the AUTO-OFF
    // routing-gate text reads this (a human is present to be asked A/B/C), so
    // skip the DB round-trip everywhere else. Fail-soft by contract (see
    // remote-seat-inventory.ts) — an inventory-check error never blocks a launch.
    const remoteSeats =
      !autoMode && planSlug && !sessionPortContext
        ? await resolveRemoteSeatInventory(workspace).catch(() => null)
        : null;

    // improve-fleet-launch-autokickoff (EI-5503) + WI-1962 + fleet-auto-mode
    // (WI-1356): the first user turn the launcher seeds, so a scripted launch —
    // plan-bound, mission-brief (--launch-context), or AUTO — STARTS working
    // instead of parking idle. The launcher GATES delivery (--no-picker, unless
    // --no-kickoff); the server supplies the canonical text (deriveKickoffPrompt,
    // pure + tested) — shared with plans:launch's headless kickoff via
    // ./launch-prompt, so the two never drift.
    const kickoffPrompt = sessionPortContext
      ? null
      : deriveKickoffPrompt({
          planSlug,
          harnessSlug,
          autoMode,
          launchContextPath,
          drainMode,
          // P-004: backend picks the guard profile; the P-001 arm outcome picks
          // the AUTO activation variant (block above — never assume armed).
          agent,
          loopAutoArmed: loopAutoArm?.armed === true,
          remoteSeats,
        });

    const result: BootstrapSuResult = {
      status: 'ok',
      sessionId,
      nativeSessionId,
      agent,
      model,
      modelSource,
      workspaceId: workspace,
      cwd,
      harnessSlug,
      planSlug,
      promptFile,
      instructionLint,
      specificationRevision: launchArtifact.specificationRevision,
      stateRevision: launchArtifact.stateRevision,
      compositionSource: launchArtifact.compositionSource,
      codexHome,
      coordExtPath,
      envelopeEnv,
      accountNotice: accountPin.notice,
      fleetNotice: fleetPin.notice,
      fleetSlug: fleetPin.fleetSlug,
      fleetRole: fleetPin.fleetRole,
      // kickoff-prompt-absorption-2026-07-17 P-001: whether the server auto-armed
      // this member's engine loop at boot (null = not attempted — a leader, an
      // unplanned session, or a non-auto launch).
      loopAutoArm,
      kickoffPrompt,
      contextBudget,
      sessionPortKickoffFile: sessionPortContext?.row.artifactPath ?? null,
      sessionPort: sessionPortContext
        ? {
            protocolVersion: sessionPortContext.row.protocolVersion,
            transformVersion: SESSION_PORT_TRANSFORM_VERSION,
            portId: sessionPortContext.row.id,
            sourceAdvSessionId: sessionPortContext.row.sourceAdvSessionId,
            renderedHash: sessionPortContext.row.renderedHash,
            status: 'pending',
          }
        : null,
    };
    if (sessionPortContext && sessionId != null) {
      const store = await import('../../../session-port/store');
      await store.recordSessionPortBootstrapReceipt({
        portId: sessionPortContext.row.id,
        workspaceId: workspace,
        requestHash: sessionPortContext.requestHash,
        targetAdvSessionId: sessionId,
        receipt: result as unknown as Record<string, unknown>,
      });
    } else if (bootstrapLedgerKey) {
      await recordAgentLaunchResult({
        workspaceId: workspace,
        idempotencyKey: bootstrapLedgerKey,
        summary: result as unknown as Record<string, unknown>,
      });
    }
    bootstrapCompleted = true;
    incompleteBootstrapSessionId = null;
    return jsonRes(result);
    } finally {
      // A validation/storage exception after winning the claim must not strand
      // an empty replay row. EI-21365235532676472 recurrence: when the exception
      // happened AFTER recordAdvSession, releasing the claim first let the
      // same-key retry win and then 409 on that PID-less/session-less ghost.
      // Terminalize the exact partial row BEFORE releasing the claim. Cleanup
      // is strict here: if the terminal write fails, retain the claim so replay
      // stays fail-closed as bootstrap_in_progress instead of racing a ghost.
      // Completed launches retain the row permanently (up to the shared ledger
      // TTL) so a lost response cannot duplicate them.
      if (sessionPortContext && !bootstrapCompleted && incompleteBootstrapSessionId != null) {
        try {
          const store = await import('../../../session-port/store');
          const failed = await store.failSessionPortTargetReservation({
            portId: sessionPortContext.row.id,
            workspaceId: workspace,
            requestHash: sessionPortContext.requestHash,
            targetAdvSessionId: incompleteBootstrapSessionId,
            error: 'session-port bootstrap failed before its replay receipt committed',
          });
          if (!failed) {
            console.warn(
              `[bootstrap-su] session-port target ${incompleteBootstrapSessionId} could not be terminalized; retaining its pending reservation`,
            );
          }
        } catch (e) {
          console.warn(
            `[bootstrap-su] session-port target ${incompleteBootstrapSessionId} failure finalization failed: ${(e as Error)?.message ?? e}`,
          );
        }
        incompleteBootstrapSessionId = null;
      }
      if (bootstrapClaimWon && !bootstrapCompleted) {
        let partialRowTerminal = true;
        if (incompleteBootstrapSessionId != null) {
          try {
            await markAdvSessionEnded(incompleteBootstrapSessionId, null, 'reconciler', {
              throwOnError: true,
            });
          } catch (e) {
            partialRowTerminal = false;
            console.warn(
              `[bootstrap-su] incomplete session ${incompleteBootstrapSessionId} could not be terminalized; ` +
              `retaining bootstrap idempotency claim: ${(e as Error)?.message ?? e}`,
            );
          }
        }
        if (partialRowTerminal) {
          await releaseAgentLaunchClaim({
            workspaceId: workspace,
            idempotencyKey: bootstrapLedgerKey,
          });
        }
      }
    }
  },
});

/**
 * POST /api/agent-mcp/console/bootstrap-su/heartbeat  { ownerId, pid?, host?, tty? }
 *
 * The psu SUPERVISOR beat (agent-liveness-heartbeat-hardening-2026-06-12
 * P-003): the launcher process — which stays alive as the agent's parent —
 * POSTs this every ~60s while its child runs, so a session in a long turn
 * with NO tool calls keeps its coord_presence row warm (process-alive
 * semantics, the interactive analog of the fleet nursery beat).
 *
 * touchHeartbeat is a no-op when no presence row exists (D-003 — the beat
 * never mints roster rows; declare-intent at session start does that).
 *
 * `pid`/`host` (WI-3898 P1, coord:presence liveness parity): optional —
 * when the launcher includes its OWN pid/hostname, they're forwarded to
 * touchHeartbeat's `liveness` param so a later same-machine reader can
 * verify liveness via `probeProcessLiveness`'s local `kill(pid, 0)` check.
 * This is the ONE call site that may legitimately report a real pid, since
 * the launcher genuinely runs as the agent's own parent process (unlike
 * writePresence's declare-intent path, which runs inside this shared
 * operator server — see presence.ts's file-header note). Loosely validated
 * (a positive integer pid, a short string host) and best-effort: a bad
 * value is just omitted rather than failing the whole beat.
 *
 * `tty` (EI-19948333346987654, sibling of pid/host): the terminal device
 * path this launch owns, self-reported from `resolveOwnedTtyPath()` —
 * same launcher, same honesty rationale. This is what makes "which
 * terminal does session X own" a coord_presence read instead of a /proc
 * ancestry walk, and lets a peer retitle/recolor that terminal (an OSC
 * write to the device path) without any window-manager query — sidestepping
 * the GNOME/Wayland wmctrl/xdotool blindness entirely (see coord:mark-terminal).
 * Loosely validated (non-empty string, capped length) and best-effort, same
 * as host.
 *
 * Deliberately NO audit/adv-session write: high-frequency + zero
 * information. Trust: principal-gated like the sibling console routes;
 * a same-UID loopback caller naming another ownerId is inside the existing
 * console trust boundary (same model as the cc/ hook chain).
 */
/**
 * EI-19412221266350408 — tell a beating launcher that its own session is FINISHED.
 *
 * The zombie: a psu-launcher whose agent session reached a terminal state while the
 * node process lived on, holding a fleet slot, a pid and a cgroup with nothing running
 * inside it. It is invisible to every cheap check and answers the WRONG way on the
 * intuitive one — `kill -0` succeeds, `ps` shows a healthy long-lived process — so a
 * leader doing process-level triage concludes "alive, therefore merely wedged".
 *
 * The launcher's own supervisor beat is what MADE it look healthy: it kept warming the
 * presence row after the session died, which is exactly why the corpse read
 * heartbeatFresh:true. So the verdict belongs on the beat's reply — the beat is both the
 * symptom's source and an existing round-trip, meaning the launcher learns it is dead
 * with no new call and no new timer.
 *
 * ⛔ WHY the ended-session query is required, and why absence is never actionable.
 * The liveness oracle's `sessionState:'recorded'` means the opposite of a terminal
 * session: `recordedLiveOwnerIds` is positive evidence of an `adv_sessions` row with
 * `ended_at IS NULL`. A launcher exiting on that state would SUICIDE ON STARTUP,
 * turning a leaked slot into a fleet that cannot boot. The oracle also signals UNKNOWN
 * BY OMISSION (EI-18771777750306094), so no verdict cannot be treated as dead either.
 *
 * Hence: emit the field ONLY when `endedRecordedOwnerIds` positively identifies the
 * owner's most-recent recorded session as ended (`ended_at IS NOT NULL`). No row, a
 * currently-live row, or a query failure ⇒ emit NOTHING, and the launcher keeps
 * running. The failure mode of this function is a zombie that lingers, never a live
 * agent that is killed.
 */
async function terminalSessionVerdict(ownerId: string): Promise<{ sessionTerminal?: true; sessionState?: string }> {
  try {
    const ended = await endedRecordedOwnerIds([ownerId]);
    return ended.has(ownerId)
      ? { sessionTerminal: true, sessionState: 'ended' }
      : {};
  } catch {
    // Never let the verdict leg fail the beat: a missed beat is a presence-warmth
    // problem, but a failed beat would break the liveness signal for a LIVE agent.
    return {};
  }
}

/**
 * WI-41197 — give a TERMINAL-launched psu session a task-ledger row, from the
 * one signal that already carries what enrolment needs.
 *
 * A session the owner starts by typing `psu` crosses no spawn chokepoint, so
 * `managedSpawn` / `beginSyncEnrolment` / `lint:no-unenrolled-spawn` all miss
 * it: measured 2026-08-24, 49 live sessions with no ledger row, hence no
 * `taskId`, hence no provenance, no safe `processes:kill { taskId }`, and
 * nothing that notices when one dies (the mechanism behind a 118-process
 * residue pileup the day before).
 *
 * The beat is the right seam because it already reports the launcher's OWN pid
 * — see the `pid`/`host` note above — so the sessions running RIGHT NOW enrol
 * within one interval, with no change to `psu-launcher.mjs` and no re-launch.
 * Full rationale: plan terminal-psu-session-enrolment-2026-08-24 D-002.
 *
 * Awaited, but structurally unable to fail the beat: `adoptTerminalSession` is
 * non-throwing by contract, and this wrapper still catches, because a missed
 * beat is a presence-warmth problem while a FAILED beat would break the
 * liveness signal for a live agent. After the first call per owner it is a Map
 * lookup, not a query. Imported lazily like `touchHeartbeat` above so the
 * route module does not pull the task-manager graph in eagerly.
 */
async function adoptTerminalSessionSoft(input: {
  ownerId: string;
  pid?: number;
  host?: string;
  tty?: string;
}): Promise<void> {
  // Headless sessions report the launcher PID too, but deliberately have no
  // terminal device. They are already enrolled by spawnHeadless inside an
  // owned scope; adopting their heartbeat again would mint a second,
  // unconfined autoReapExempt "terminal" row for the same process tree.
  // A real terminal launch owns a TTY (the discriminator this route already
  // validates), so require both pieces before crossing the terminal-adoption
  // seam. Presence liveness still receives pid/host for every launch below.
  if (input.pid == null || !input.tty) return;
  try {
    const { adoptTerminalSession } = await import('../../../task-manager/adopt-terminal-session');
    await adoptTerminalSession(input);
  } catch {
    /* never let enrolment cost a live agent its heartbeat */
  }
}

const heartbeat = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/heartbeat',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let ownerId = '';
    let pid: number | undefined;
    let host: string | undefined;
    let tty: string | undefined;
    try {
      const body = (await req.json()) as { ownerId?: unknown; pid?: unknown; host?: unknown; tty?: unknown };
      if (typeof body.ownerId === 'string') ownerId = body.ownerId.trim();
      if (typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0) {
        pid = body.pid;
      }
      if (typeof body.host === 'string' && body.host.trim() && body.host.length <= 255) {
        host = body.host.trim();
      }
      if (typeof body.tty === 'string' && body.tty.trim() && body.tty.length <= 255) {
        tty = body.tty.trim();
      }
    } catch {
      /* fall through to the 400 */
    }
    if (!ownerId || ownerId.length > 200) {
      return jsonRes({ error: 'ownerId required' }, 400);
    }
    try {
      const { touchHeartbeat } = await import('../../../agent-tools/coordination/presence');
      await touchHeartbeat(
        ownerId,
        pid != null || host != null || tty != null ? { pid, host, tty } : undefined,
      );
      await adoptTerminalSessionSoft({ ownerId, pid, host, tty });
      return jsonRes({ ok: true, ...(await terminalSessionVerdict(ownerId)) });
    } catch (err) {
      // Best-effort contract: the launcher treats any failure as a missed
      // beat, never an error loop.
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForHeartbeat = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/heartbeat',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/**
 * POST /api/agent-mcp/console/bootstrap-su/session-ended
 *   { advSessionId, exitCode?, killedBySignal?, launchFailed?, endAttemptKey }
 *
 * The psu launcher's exit report. psu stays alive as the agent's parent in
 * BOTH launch paths (the same property the supervisor beat rides), and on
 * child exit it stamps the tracked adv_sessions row's ended_at/exit_code
 * here. Before this, CONSOLE sessions never got ended_at (markAdvSessionEnded
 * only fired for server-spawned terminals), so every dead launch sat
 * "· active" in the `psu --resume` picker forever — and the session-dir GC's
 * open-row protection never expired, wedging collection of abandoned dirs.
 *
 * Acknowledged replay-safe contract: endAttemptKey stays stable across the
 * launcher's bounded retries, and markAdvSessionEnded is idempotent. A claimed resume that never starts a
 * child reports `launchFailed:true`; that is a CLOSE, not an observed child
 * exit, so it maps to `ended_by='cleanup'` and becomes immediately retryable.
 * markAdvSessionEnded is idempotent — it only stamps an unset ended_at — so a
 * duplicate report is harmless.
 */
const sessionEnded = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-ended',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let advSessionId: number | null = null;
    let exitCode: number | null = null;
    let killedBySignal: string | null = null;
    let launchFailed = false;
    let endAttemptKey: string | null = null;
    let observedAt: Date | null = null;
    try {
      const body = (await req.json()) as {
        advSessionId?: unknown;
        exitCode?: unknown;
        killedBySignal?: unknown;
        launchFailed?: unknown;
        endAttemptKey?: unknown;
        observedAt?: unknown;
      };
      // WI-10002854: when the launcher OBSERVED the exit. A replayed pending witness carries
      // its ORIGINAL observation time, so markAdvSessionEnded can refuse to end a successor
      // incarnation that started after it. An unparseable value is ignored (legacy behaviour).
      if (typeof body.observedAt === 'string') {
        const parsed = new Date(body.observedAt);
        if (!Number.isNaN(parsed.getTime())) observedAt = parsed;
      }
      if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
        advSessionId = body.advSessionId;
      }
      if (typeof body.exitCode === 'number' && Number.isInteger(body.exitCode)) {
        exitCode = body.exitCode;
      }
      // Shape-validated rather than trusted: this string is persisted and then read back
      // as the reason an agent died, so it must be a signal NAME and nothing else.
      killedBySignal = parseKilledBySignalReport(body.killedBySignal);
      launchFailed = body.launchFailed === true;
      if (typeof body.endAttemptKey === 'string') {
        const candidate = body.endAttemptKey.trim();
        if (candidate && candidate.length <= 200) endAttemptKey = candidate;
      }
    } catch {
      /* fall through to the 400 */
    }
    if (advSessionId == null || advSessionId <= 0) {
      return jsonRes({ error: 'advSessionId required' }, 400);
    }
    if (!endAttemptKey) {
      return jsonRes({ error: 'endAttemptKey required' }, 400);
    }
    try {
      // WI-38054: 'self' is a claim about VOLUNTARINESS, not merely about who reported.
      // This endpoint used to hardcode it, so every kill the launcher observed — an
      // owner's Ctrl-C, an OOM, a :3270 sidecar restart tearing down its cgroup — was
      // recorded as the session choosing to exit. Combined with node-pty's exitCode 0
      // for a signal death, the row then asserted a clean exit outright, which is why a
      // mass reap of the owner's agents was indistinguishable from two normal endings.
      // A launch failure means no child ever ran. Prefer the explicit cleanup
      // classification even if a malformed/overlapping report also contains a
      // signal; `ended_signal` is only valid for observed signal exits.
      const endedBy = launchFailed ? 'cleanup' : killedBySignal ? 'signal' : 'self';
      // `ended:false` is still ok:true: the row was already ended, or (with observedAt) a
      // successor incarnation started after this observation — either way the launcher must
      // DROP its pending witness rather than replay a stale end forever.
      const ended = await markAdvSessionEnded(advSessionId, exitCode, endedBy, {
        signal: launchFailed ? null : killedBySignal,
        throwOnError: true,
        observedAt,
      });
      return jsonRes({ ok: true, ended, endAttemptKey });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForSessionEnded = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-ended',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/**
 * POST /api/agent-mcp/console/bootstrap-su/session-resumed
 *   { advSessionId, resumeClaimKey? }
 *
 * The psu launcher's atomic RESUME acquisition. A keyed caller receives an
 * explicit short-lived reservation; acquisition preserves terminal evidence and
 * therefore does not assert that a child exists. The caller must finalize that
 * reservation from concrete spawn evidence, or release it on setup failure.
 * Legacy no-key callers retain the historical one-step claim during rollout.
 *
 * The keyed response is typed (`acquired` + `status` and lease metadata) and also
 * keeps the historical `reactivated` field for compatibility. In either shape,
 * false means "the right to resume was not acquired — do not spawn".
 */
const sessionResumed = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resumed',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let advSessionId: number | null = null;
    let resumeClaimKey: string | null = null;
    let localLivenessEvidence: unknown = undefined;
    try {
      const body = (await req.json()) as {
        advSessionId?: unknown;
        resumeClaimKey?: unknown;
        localLivenessEvidence?: unknown;
      };
      if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
        advSessionId = body.advSessionId;
      }
      if (body.resumeClaimKey != null) {
        if (typeof body.resumeClaimKey !== 'string') {
          return jsonRes({ error: 'resumeClaimKey must be a non-empty string of at most 200 characters' }, 400);
        }
        resumeClaimKey = body.resumeClaimKey.trim();
        if (!resumeClaimKey || resumeClaimKey.length > 200) {
          return jsonRes({ error: 'resumeClaimKey must be a non-empty string of at most 200 characters' }, 400);
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, 'localLivenessEvidence')) {
        if (!isAdvSessionLocalLivenessEvidence(body.localLivenessEvidence)) {
          return jsonRes({
            error:
              "localLivenessEvidence must be { version: 1, kind: 'no-live-codex-writer' | 'no-live-claude-process' | 'no-live-omp-process' }",
          }, 400);
        }
        localLivenessEvidence = body.localLivenessEvidence;
      }
    } catch {
      /* fall through to the 400 */
    }
    if (advSessionId == null || advSessionId <= 0) {
      return jsonRes({ error: 'advSessionId required' }, 400);
    }
    try {
      if (resumeClaimKey) {
        const reservation = localLivenessEvidence === undefined
          ? await acquireAdvSessionResume(advSessionId, resumeClaimKey)
          : await acquireAdvSessionResume(
            advSessionId,
            resumeClaimKey,
            undefined,
            undefined,
            localLivenessEvidence,
          );
        return jsonRes({ ok: true, ...reservation, reactivated: reservation.acquired });
      }
      const claimed = await claimAdvSessionResume(advSessionId, null);
      return jsonRes({ ok: true, reactivated: claimed });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

async function parseResumeTransitionBody(
  req: Request,
): Promise<{ advSessionId: number; resumeClaimKey: string; launchArgv?: string[] } | Response> {
  let advSessionId: number | null = null;
  let resumeClaimKey: string | null = null;
  let launchArgv: string[] | undefined;
  try {
    const body = (await req.json()) as {
      advSessionId?: unknown;
      resumeClaimKey?: unknown;
      launchArgv?: unknown;
    };
    if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
      advSessionId = body.advSessionId;
    }
    if (typeof body.resumeClaimKey === 'string') {
      const candidate = body.resumeClaimKey.trim();
      if (candidate && candidate.length <= 200) resumeClaimKey = candidate;
    }
    if (body.launchArgv !== undefined) {
      if (
        !Array.isArray(body.launchArgv) ||
        body.launchArgv.length === 0 ||
        body.launchArgv.length > 256 ||
        !body.launchArgv.every(
          (arg): arg is string =>
            typeof arg === 'string' && arg.length > 0 && arg.length <= 4096,
        )
      ) {
        return jsonRes(
          {
            error:
              'launchArgv must be a non-empty array of strings (at most 256 entries, each at most 4096 characters)',
          },
          400,
        );
      }
      launchArgv = body.launchArgv;
    }
  } catch {
    /* return the shared validation response below */
  }
  if (advSessionId == null || advSessionId <= 0) {
    return jsonRes({ error: 'advSessionId required' }, 400);
  }
  if (!resumeClaimKey) {
    return jsonRes({ error: 'resumeClaimKey must be a non-empty string of at most 200 characters' }, 400);
  }
  return { advSessionId, resumeClaimKey, ...(launchArgv ? { launchArgv } : {}) };
}

/** Finalize a keyed resume reservation from concrete child/host spawn evidence. */
const sessionResumeFinalized = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resume-finalized',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    const parsed = await parseResumeTransitionBody(req);
    if (parsed instanceof Response) return parsed;
    try {
      const finalized = await finalizeAdvSessionResume(
        parsed.advSessionId,
        parsed.resumeClaimKey,
        parsed.launchArgv,
      );
      return jsonRes({ ok: true, finalized, resumeClaimKey: parsed.resumeClaimKey });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForSessionResumeFinalized = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resume-finalized',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/** Release a keyed reservation after setup/pre-spawn failure without asserting liveness. */
const sessionResumeReleased = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-resume-released',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    const parsed = await parseResumeTransitionBody(req);
    if (parsed instanceof Response) return parsed;
    try {
      const released = await releaseAdvSessionResume(parsed.advSessionId, parsed.resumeClaimKey);
      return jsonRes({ ok: true, released, resumeClaimKey: parsed.resumeClaimKey });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForSessionResumeReleased = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resume-released',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const optionsForSessionResumed = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-resumed',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

/**
 * POST /api/agent-mcp/console/bootstrap-su/session-respawned
 *   { advSessionId?, coordOwnerId?, sessionId }
 *
 * The psu launcher's RESPAWN report (WI-5075) — the managed pty host replaced the
 * agent child with a fresh successor under a NEW native `--session-id` (P-018
 * carry-respawn / cold-loop RECYCLE), keeping the same coord identity and adv
 * row. Re-anchors the row's `session_id` to the successor so every owner→native
 * consumer — above all the compaction watchdog's context estimate — tracks the
 * LIVE incarnation instead of the dead predecessor's transcript. Without this,
 * the estimate stays pinned over-limit and the watchdog re-kills each successor
 * at every retry-grace expiry (the 2026-07-15/16 kill loop).
 *
 * Keyed by `advSessionId` when the launch env carried one (the adv-spawned
 * cohort). Only reports with NO adv id use the legacy `coordOwnerId` fallback;
 * a supplied-but-missing id must never be redirected to a sibling row, because
 * the row id is also the Codex home key (WI-42507). At least one key is required.
 *
 * Best-effort + idempotent like its ended/resumed siblings: re-anchoring to the
 * already-recorded id is a no-op, and the launcher swallows any failure.
 */
const sessionRespawned = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-su/session-respawned',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;
    let advSessionId: number | null = null;
    let coordOwnerId: string | null = null;
    let sessionId: string | null = null;
    try {
      const body = (await req.json()) as {
        advSessionId?: unknown;
        coordOwnerId?: unknown;
        sessionId?: unknown;
      };
      if (typeof body.advSessionId === 'number' && Number.isInteger(body.advSessionId)) {
        advSessionId = body.advSessionId;
      }
      if (typeof body.coordOwnerId === 'string' && body.coordOwnerId.trim().length > 0) {
        coordOwnerId = body.coordOwnerId.trim().slice(0, 200);
      }
      if (typeof body.sessionId === 'string' && NATIVE_SESSION_ID_RE.test(body.sessionId.trim())) {
        sessionId = body.sessionId.trim();
      }
    } catch {
      /* fall through to the 400 */
    }
    if ((advSessionId == null || advSessionId <= 0) && !coordOwnerId) {
      return jsonRes({ error: 'advSessionId or coordOwnerId required' }, 400);
    }
    if (!sessionId) {
      return jsonRes({ error: 'sessionId (native session UUID) required' }, 400);
    }
    try {
      let reanchored = false;
      let owner: string | null = null;
      if (advSessionId != null && advSessionId > 0) {
        ({ reanchored, owner } = await reanchorAdvSessionNativeId(advSessionId, sessionId));
      }
      // Owner-keyed fallback is reserved for legacy reports that genuinely carry
      // no adv id. A supplied id that touches no row is NOT permission to choose
      // a different row by owner; that is the numeric-home identity split this
      // route is responsible for preventing.
      if (advSessionId == null && coordOwnerId) {
        const fallback = await reanchorAdvSessionNativeIdByOwner(coordOwnerId, sessionId);
        reanchored = fallback.reanchored;
        owner = fallback.owner ?? owner;
      }
      if (owner) {
        await bindKnownAgentSessionTasks({
          workspaceId: activeWorkspaceId(),
          coordOwnerId: owner,
          sessionId,
          source: 'respawn',
        });
      }
      // Frozen-gauge fix: the successor keeps the coord ownerId, so the
      // in-process context-usage cache still holds the DEAD predecessor's
      // near-limit estimate — a fresh successor rendering "89%" gets nudged
      // into an immediate pointless re-cut. Clear it; the next watchdog pass
      // measures the real successor transcript. Best-effort like the reanchor.
      // WI-41555: gauge hygiene follows the EVENT (a respawn happened, and here
      // is the owner it happened to), NEVER "did a DB row change". `owner` used
      // to come back null on every no-op re-anchor, which is the ORDINARY case
      // for the cold-loop recycle cohort — the spawn path stamps the new native
      // id onto the row before this report lands, so both UPDATEs match zero
      // rows. That silently skipped the two clears below and left the anchored
      // gauge serving the DEAD predecessor's token count indefinitely: a fresh
      // successor renders ~81%, obeys its own compaction discipline, re-cuts at
      // once, and ITS successor inherits the same frozen number — an unbounded
      // reset loop in which no session ever does any work. The re-anchors now
      // report the row's owner regardless; this falls back to the owner the
      // REPORT names so a missing or racing adv row cannot resurrect the bug.
      // Clearing is idempotent and self-healing (the next read reseeds from the
      // successor's real transcript), so an extra clear costs nothing.
      const gaugeOwner = owner ?? coordOwnerId;
      if (gaugeOwner) {
        // EI-21567375926533125: scheduler:get_next reads the PG-canonical
        // coord_presence estimate, not either in-process render cache below.
        // A carry-respawn can preserve pid=NULL, so the store's pid-transition
        // invalidation never fires; clear the predecessor estimate at this
        // confirmed native-session replacement boundary. The detached
        // session-compacted bridge may race this route, but it now writes only
        // after proving it resolved this exact successor native id.
        try {
          const { clearContextEstimate } = await import('../../../agent-tools/coordination/presence');
          await clearContextEstimate(gaugeOwner);
        } catch {
          /* gauge hygiene must never fail the respawn report */
        }
        try {
          const { clearContextUsage } = await import('../../../system-health/context-usage-cache');
          clearContextUsage(gaugeOwner);
        } catch {
          /* gauge hygiene must never fail the respawn report */
        }
        // EI-12966: the watchdog-mirror cache above is only a fallback/limit
        // source now — the LIVE render paths (P-013 result annotator, P-015
        // PostToolUse hook fold) read the WI-4154 anchored incremental cache
        // in compaction-usage.ts instead, which has its OWN per-owner cache
        // keyed on the dead predecessor's transcript path. That anchor's fast
        // path never re-resolves the session ref, so left uncleared it keeps
        // serving the byte-identical PRE-respawn reading indefinitely (the
        // "stale CRITICAL gauge on the first post-compaction tool call" bug —
        // not just for up to one watchdog pass, but forever until this clears
        // it). Clear it too so the very next read reseeds from the successor's
        // real transcript.
        try {
          const { clearContextAnchor } = await import('../../../compaction-usage');
          clearContextAnchor(gaugeOwner);
        } catch {
          /* gauge hygiene must never fail the respawn report */
        }
      }
      return jsonRes({ ok: true, reanchored });
    } catch (err) {
      return jsonRes({ ok: false, error: err instanceof Error ? err.message : String(err) }, 503);
    }
  },
});

const optionsForSessionRespawned = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-su/session-respawned',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

export default [
  options,
  optionsForOptions,
  bootstrapSu,
  optionsGet,
  brainGet,
  heartbeat,
  optionsForHeartbeat,
  sessionEnded,
  optionsForSessionEnded,
  sessionResumed,
  optionsForSessionResumed,
  sessionResumeFinalized,
  optionsForSessionResumeFinalized,
  sessionResumeReleased,
  optionsForSessionResumeReleased,
  sessionRespawned,
  optionsForSessionRespawned,
];
