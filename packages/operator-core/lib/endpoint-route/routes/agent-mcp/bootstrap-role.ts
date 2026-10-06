/**
 * POST / OPTIONS /api/agent-mcp/console/bootstrap-role
 *
 * Bootstraps a tracked, role-scoped INTERACTIVE session (psu --role).
 * The agent wears a pipeline role's persona + tools + feature context —
 * the same setup the orchestrator gives that role — but a human drives
 * it. Sibling to bootstrap-su (which is the plain SU/engineer path).
 *
 * Per agent-launch-unification Phase 3 (P-021). Composes the shared
 * keystone `buildRoleLaunchSpec` (role prompt via assembleRolePrompt + a
 * signed ROLE-SCOPED MCP URL → dispatch enforces the role's tool
 * allowlist, D-001), then:
 *   - writes the signed `.mcp.json` into the session cwd (backing up any
 *     existing one, like console-launch),
 *   - writes the role prompt to a launch-context file the launcher feeds
 *     the CLI as its system prompt,
 *   - records an `adv_sessions` row tagged role + feature + agent,
 *   - returns what psu needs to exec the chosen backend interactively.
 *
 * Feature gating: a role whose `consumes.feature === 'required'`
 * (roleConsumes) must be given a feature, else 400.
 *
 * Principal-gated; CORS-open (operator binds loopback-only).
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId, isKnownWorkspace } from '../../../workspace-registry';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import {
  adoptStartingTerminalLaunch,
  markAdvSessionEnded,
  recordAdvSession,
  recordSuLaunchSpec,
  repairStaleAdvSessionTerminalMarkers,
} from '../../../adv-sessions';
import { resolveSessionStates } from '../../../agent-tools/coordination/liveness-oracle';
import {
  claimAgentLaunch,
  recordAgentLaunchResult,
  releaseAgentLaunchClaim,
} from '../../../agent-launch-core';
import {
  classifyPrePinnedOwnerRows,
  describePrePinnedConflicts,
  mapPrePinnedOwnerSessionState,
  type PrePinnedOwnerRow,
} from './pre-pinned-owner-rows';
import { isSuAgent, type SuAgent } from '../../../su-agents';
import { normalizeSuContextSize } from '../../../su-context-size.mjs';
import { roleConsumes } from '../../../role-registry';
import { buildRoleLaunchSpec, mintRoleLaunchIdentity, resolveLaunchIdentityModelDefault } from '../../../role-launch-spec';
import { papercuspPathForWorkspace } from '../../../papercusp-root';
import { getPlanContextBySlug } from '../../../plan-context-for-feature';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { assembleSpawnHydration } from '../../../fleet/spawn-hydration';
import { productionSpawnHydrationDeps } from '../../../fleet/spawn-hydration-deps';
import { writeRoleCodexHome } from '../../../role-codex-home';
import { writeInteractiveClaudeConfig } from '../../../interactive-claude-config';
import {
  materializeCodexPrompts,
  materializeWorkspacePrompts,
  materializeHarnessPrompts,
} from '../../../saved-prompts-materialize';
import { emitCodexSlashToolPrompts } from '../../../slash-tool-prompts-codex';
import { launchContextDir, launchContextPathFor } from '../../../su-launch-context';
import {
  resolveAccountPin,
  resolveFleet,
  reconstructPsuLaunchArgv,
  stampFleetMembershipAtBoot,
  stampPresenceAtBoot,
} from './bootstrap-su';
import { backendFeatureGuard } from '../../../backend-feature-capabilities';
import { resolveCodexModelSelection } from '../../../model-context-budget.mjs';
import { getOrgPg } from '@papercusp/db-org';
import { resolveProjectDir } from '../../../spawn-config';
import { resolveAcceptedOperationWorkerBinding, selectAcceptedOperationWorkerModel } from '../../../blueprint/operation-worker-binding';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization',
};

function jsonRes(body: unknown, init?: number | ResponseInit): Response {
  const r = Response.json(body, typeof init === 'number' ? { status: init } : init);
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

async function gatePrincipal(headers: Headers): Promise<Response | null> {
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

const ROLE_RE = /^[a-z][a-z0-9-]*$/;

export interface BootstrapRoleResult {
  status: 'ok';
  sessionId: number | null;
  role: string;
  agent: SuAgent;
  /** Server-selected model; an accepted operation policy outranks launch args. */
  model: string | null;
  workspaceId: string;
  /** null = a workspace-level (harness-less) role session (P-003). */
  harnessSlug: string | null;
  feature: string | null;
  /** Plan whose context was injected (plan-consuming roles), else null. */
  planSlug: string | null;
  /** Working directory the launcher should exec the agent in. */
  cwd: string;
  /**
   * File holding the role prompt — the launcher feeds it as the system
   * prompt. claude/omp: a launch-context `.md`. codex: the CODEX_HOME
   * `AGENTS.md` (codex has no per-launch system-prompt flag).
   */
  promptFile: string;
  /**
   * The signed role-scoped MCP config the agent discovers. claude/omp: a
   * per-session `.mcp.json` under the launch-context MCP directory. codex:
   * the CODEX_HOME `config.toml`.
   */
  mcpJsonPath: string;
  /**
   * Per-session CODEX_HOME for a codex role session (AGENTS.md +
   * config.toml + auth symlink). null for claude/omp. Also surfaced in
   * `envelopeEnv.CODEX_HOME` for the launcher.
   */
  codexHome: string | null;
  /** Human-facing account pin result; null when no pin was requested or it resolved cleanly to default behavior. */
  accountNotice?: string | null;
  /**
   * named-su-agent-fleets P-009: a human-readable note about the chosen fleet,
   * mirroring bootstrap-su's fleetNotice — "leading fleet X (Name)." / "joined
   * fleet X as <role>." / the fail-soft reason it was skipped. null when no fleet
   * was chosen.
   */
  fleetNotice?: string | null;
  /** WI-1408: the resolved fleet slug/role, or null when no fleet was requested. When
   *  a fleet WAS requested this route never returns `status: 'ok'` with a null
   *  `fleetSlug` (see the `fleetRequested` guard above) — resolution failure is a
   *  hard error instead. */
  fleetSlug?: string | null;
  fleetRole?: string | null;
  /** WI-4608: the RESOLVED initial MCP tool-surface size — the explicit
   *  `context_size` request, or buildRoleLaunchSpec's per-role auto-select
   *  (trimmed for mug/kettle, full otherwise). Mirrors bootstrap-su surfacing
   *  its resolved `personaTier`. */
  contextSize: 'full' | 'trimmed';
  /** Exact P-038 artifact/state revisions materialized for this launch. */
  specificationRevision: string;
  stateRevision: string;
  compositionSource: 'blueprint' | 'compatibility';
  /** Non-secret env the launcher exports into the child. */
  envelopeEnv: Record<string, string>;
}

const options = defineTool({
  method: 'OPTIONS',
  path: '/agent-mcp/console/bootstrap-role',
  auth: 'public',
  handler() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/console/bootstrap-role',
  auth: 'loopback',
  async handler(req) {
    const denied = await gatePrincipal(req.headers);
    if (denied) return denied;

    let body: {
      role?: string;
      agent?: string;
      /** Coordination identity reserved by the canonical launcher. Does not change role authority. */
      owner_id?: string | null;
      /** Attribution for safe managed-host recovery; does not change role authority. */
      launched_by?: string | null;
      /** Stable psu request key for safe same-launch retries after an upstream timeout. */
      bootstrap_idempotency_key?: unknown;
      workspace?: string | null;
      harness_slug?: string | null;
      feature?: string | null;
      plan?: string | null;
      account?: string | null;
      model?: string | null;
      model_source?: 'explicit' | 'inherited' | 'configured-default' | null;
      /** Windowless/unattended launch posture supplied by psu. */
      headless?: boolean | null;
      /** named-su-agent-fleets P-009: the durable slug of a named fleet to JOIN
       *  (member). Folded into PAPERCUSP_FLEET_SLUG/PAPERCUSP_FLEET_ROLE on the
       *  spawn env, mirroring bootstrap-su. Ignored when `fleet_name` is present
       *  (a new fleet wins). */
      fleet?: string | null;
      /** Membership role for `fleet` — 'leader' | 'member' (default member). */
      fleet_role?: string | null;
      /** named-su-agent-fleets P-009: a freshly-entered fleet NAME. The server
       *  derives its slug + creates the agent_fleets row with this session as
       *  leader (D-002). */
      fleet_name?: string | null;
      /** WI-4608: initial MCP tool-surface size — 'full' | 'trimmed'. Mirrors
       *  bootstrap-su's `context_size` body field (same snake_case wire name, same
       *  `psu --context-size=<value>` CLI flag now meaningful for a `--role` launch
       *  too, not just `su`). Omitted → buildRoleLaunchSpec auto-selects per role
       *  (trimmed for mug/kettle, full otherwise). */
      context_size?: string | null;
      /** Explicit launch-time identity bindings; omitted selects roles[].stack. */
      stack?: string[] | null;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return jsonRes({ status: 'error', error: 'invalid JSON body' }, 400);
    }

    if (body.launched_by != null && typeof body.launched_by !== 'string') {
      return jsonRes({ status: 'error', error: 'launched_by must be a string' }, 400);
    }
    const launchedBy = body.launched_by?.trim() || null;
    if (launchedBy && !/^[A-Za-z0-9._:-]{1,120}$/.test(launchedBy)) {
      return jsonRes({ status: 'error', error: 'launched_by must be an owner id' }, 400);
    }

    const role = body.role?.trim() || '';
    if (!ROLE_RE.test(role)) {
      return jsonRes({ status: 'error', error: `invalid role: ${role.slice(0, 32)}` }, 400);
    }
    // RETIREMENT GATE (retire-mug-kettle-su-only-2026-08-09 P-013 / D-022) — the
    // THIRD spawn door. D-018 gated the two chokepoints an OPERATOR-side launch
    // traverses (`fleet/operator-spawn.ts`, the `/invoke` route) and its header
    // asserts the surface has "exactly TWO doors". That is FALSE for the console
    // path: `psu --role <role>` routes any non-su-tier role through `roleFlow`
    // (SU_TIER_ROLES = ['planner'], so mug/kettle/cup all qualify), which POSTs
    // HERE and then EXECS THE BACKEND LOCALLY — `spawnAgentInHarness` is never
    // called and the /invoke route is never hit. Without this gate the retired
    // tier stays launchable by name with the flag OFF, which is precisely what
    // P-013 exists to prevent. This route is bootstrap-role's ONLY caller, so
    // one gate here closes the door completely.
    //
    // Keyed on `isRetiredTierRole` (NOT a raw string match) so the pre-rename
    // aliases queen/bee/overwatch are canonicalized first — same predicate the
    // other two doors share, so the three cannot drift apart.
    const { isRetiredTierRole } = await import('../../../pot/retired-tier-roles');
    if (isRetiredTierRole(role)) {
      const { mugKettleSystemEnabled } = await import('../../../pot/started');
      if (!(await mugKettleSystemEnabled())) {
        return jsonRes(
          {
            status: 'error',
            code: 'mug_kettle_retired',
            retired: 'permanent',
            error:
              `Cannot launch role="${role}" — the Mug/Kettle/Cup tier is RETIRED, permanently. ` +
              `Launch an su fleet instead — fleet:launch-on-plan. ` +
              `There is no longer a flag to flip: the reversible escape hatch ` +
              `(papercusp-mug-kettle-system) was deleted in P-068, which is how that flag ` +
              `was always specified to graduate.`,
          },
          403,
        );
      }
    }
    if (!isSuAgent(body.agent)) {
      return jsonRes({ status: 'error', error: `agent must be one of claude|omp|codex (got ${String(body.agent).slice(0, 24)})` }, 400);
    }
    const agent: SuAgent = body.agent;

    const workspace = body.workspace?.trim() || activeWorkspaceId();
    // isKnownWorkspace (NOT raw workspaceById): 'default' — the sentinel activeWorkspaceId()
    // returns on a sparse/fresh registry and the value /options hands the launcher — is
    // always valid, as is a PAPERCUSP_WORKSPACE_ID pin. workspaceById() rejected the exact
    // value this resolver produces, 400ing `unknown workspace: default` on fresh installs
    // (role launch). Sibling fix to bootstrap-su.ts (WI-3234).
    if (body.workspace?.trim() && !isKnownWorkspace(workspace)) {
      return jsonRes({ status: 'error', error: `unknown workspace: ${workspace.slice(0, 48)}` }, 400);
    }
    // null = a WORKSPACE-LEVEL role session (owner-confirmed, hive-agent-tabs
    // P-003: operator/planner launch without a harness — the SU model). A
    // feature-consuming role still needs the harness its feature lives in.
    const harnessSlug = body.harness_slug?.trim() || null;
    const feature = body.feature?.trim() || null;
    const plan = body.plan?.trim() || null;
    const normalizedContextSize = normalizeSuContextSize(body.context_size);
    if (!normalizedContextSize.ok) {
      return jsonRes({ status: 'error', error: normalizedContextSize.error }, 400);
    }
    const contextSize = normalizedContextSize.contextSize;
    if (
      body.stack != null &&
      (!Array.isArray(body.stack) ||
        body.stack.length > 40 ||
        body.stack.some((ref) => typeof ref !== 'string' || !ref.trim()))
    ) {
      return jsonRes({ status: 'error', error: 'stack must be an array of 1-40 non-empty slot:id refs' }, 400);
    }
    if (body.headless != null && typeof body.headless !== 'boolean') {
      return jsonRes({ status: 'error', error: 'headless must be a boolean' }, 400);
    }
    const headless = body.headless === true;
    const suppliedModel = body.model?.trim() || null;
    const requestedModel = body.model_source === 'configured-default' ? null : suppliedModel;
    let acceptedOperation;
    try {
      acceptedOperation = feature && harnessSlug
        ? await resolveAcceptedOperationWorkerBinding({
            sql: getOrgPg().sql,
            workspaceId: workspace,
            harnessSlug,
            workItemId: feature,
            role,
            repoDir: await resolveProjectDir(harnessSlug, workspace) ?? '',
          })
        : null;
    } catch (error) {
      return jsonRes({ status: 'error', code: 'operation_worker_denied',
        error: error instanceof Error ? error.message : String(error),
        refusal: {
          observed: { harness: harnessSlug, feature, role },
          liftsWhen:
            'the launch matches an accepted blueprint operation: the work-item (`feature`) exists in this ' +
            'harness, `role` is a worker role that operation authorizes, and its pinned worker identity ' +
            'resolves unchanged (`error` names which check failed). Retrying the identical request cannot ' +
            'lift it: relaunch with a feature/role the accepted operation authorizes, or have the owner ' +
            're-accept the operation or repin its worker identity',
          whoCanMakeItTrue: ['self', 'owner'],
        } }, 400);
    }
    let identityModelDefault: string | null;
    const identityStack = acceptedOperation?.stack ?? body.stack;
    try {
      identityModelDefault = await resolveLaunchIdentityModelDefault({
        cwd: harnessSlug ? await resolveProjectDir(harnessSlug, workspace) ?? '' : papercuspPathForWorkspace(workspace),
        harnessSlug, role, stack: identityStack,
      });
    } catch (error: any) {
      return jsonRes({ status: 'error', code: 'identity_model_default_denied', error: error?.message ?? String(error),
        refusal: {
          observed: { harness: harnessSlug, role, stack: identityStack?.join(',') ?? null },
          liftsWhen:
            'the selected launch identity stack resolves against this harness\'s blueprint source: every ' +
            'stack ref (and a `composition:` root) exists and loads, so its model default can be read ' +
            '(`error` names the failing ref). Retrying the identical request cannot lift it: correct the ' +
            'stack ref or repair the identity definition',
          whoCanMakeItTrue: ['self', 'owner'],
        } }, 400);
    }
    let modelSelection;
    try {
      modelSelection = selectAcceptedOperationWorkerModel(acceptedOperation, requestedModel, agent);
    } catch (error) {
      return jsonRes({ status: 'error', code: 'operation_model_denied',
        error: error instanceof Error ? error.message : String(error),
        refusal: {
          observed: { role, agent, requestedModel, policyMode: acceptedOperation?.modelPolicy?.mode ?? null },
          liftsWhen:
            'the requested model is one the accepted operation\'s model policy admits on this backend: omit ' +
            '`model` to take the policy\'s first accepted model, or request a listed model at the policy\'s ' +
            'reasoning effort. An OMP backend is never admissible for a policy-bound worker: launch on claude ' +
            'or codex. Retrying the identical request cannot lift it; widening the policy needs the owner',
          whoCanMakeItTrue: ['self', 'owner'],
        } }, 409);
    }
    let model = modelSelection?.model ?? requestedModel ?? identityModelDefault ?? suppliedModel;
    let modelSource: 'explicit' | 'inherited' | 'configured-default' | null = null;
    if (agent === 'codex') {
      try {
        const selection = resolveCodexModelSelection(model, {
          source:
            (modelSelection ? 'explicit' : !requestedModel && identityModelDefault ? 'inherited' : body.model_source) ??
            (requestedModel ? 'explicit' : headless ? 'explicit' : 'configured-default'),
        });
        model = selection.model;
        modelSource = selection.source;
      } catch (error: any) {
        return jsonRes({ status: 'error', code: error?.code ?? 'codex_model_denied', error: error?.message ?? String(error) }, 400);
      }
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
    const bootstrapLedgerKey = bootstrapIdempotencyKey
      ? `bootstrap-role:${bootstrapIdempotencyKey}`
      : null;
    let bootstrapClaimWon = false;
    let bootstrapCompleted = false;
    let incompleteBootstrapSessionId: number | null = null;
    if (bootstrapLedgerKey) {
      const claim = await claimAgentLaunch({
        workspaceId: workspace,
        idempotencyKey: bootstrapLedgerKey,
        launchedBy: launchedBy ?? (typeof body.owner_id === 'string' ? body.owner_id.trim() || null : null),
      });
      if (!claim.won) {
        const prior = claim.priorSummary;
        if (prior?.status === 'ok') {
          return jsonRes({ ...(prior as unknown as BootstrapRoleResult), bootstrapDeduped: true });
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
    // Honor the same pre-pinned identity contract as bootstrap-su. A role
    // launch must not detach the actual worker from its canonical receipt.
    if (body.owner_id != null && typeof body.owner_id !== 'string') {
      return jsonRes({ status: 'error', error: 'owner_id must be a string' }, 400);
    }
    const requestedSid = body.owner_id?.trim() || null;
    let adoptableStartingRowId: number | null = null;
    if (requestedSid) {
      if (!/^su-[A-Za-z0-9][A-Za-z0-9._-]{5,118}$/.test(requestedSid)) {
        return jsonRes({ status: 'error', error: 'owner_id must match su-<slug> (6-119 chars of [A-Za-z0-9._-])' }, 400);
      }
      await repairStaleAdvSessionTerminalMarkers(requestedSid);
      const { sql } = getOrgPg();
      const live = await sql<PrePinnedOwnerRow[]>`
        SELECT id::text, display, (session_id IS NOT NULL) AS has_session,
               (launched_at IS NOT NULL) AS launched
          FROM harness_shared.adv_sessions
         WHERE coord_owner_id = ${requestedSid} AND ended_at IS NULL
         ORDER BY id DESC
      `;
      const oracleState = await resolveSessionStates([{ ownerId: requestedSid }], { hydratePerId: true })
        .then((verdicts) => verdicts.get(requestedSid)?.sessionState)
        .catch(() => undefined);
      const liveness = mapPrePinnedOwnerSessionState(oracleState);
      const { precursors, reclaimableConflicts, conflicts } = classifyPrePinnedOwnerRows(
        live.map((row) => ({ ...row, liveness })),
      );
      if (conflicts.length > 0) {
        return jsonRes({ status: 'error',
          error: `owner_id ${requestedSid} is already bound to live adv session ${conflicts[0].id} — pre-pinned owners must be fresh [live rows: ${describePrePinnedConflicts(conflicts)}]`,
        }, 409);
      }
      for (const stranded of reclaimableConflicts) {
        await markAdvSessionEnded(Number(stranded.id), null, 'reconciler');
      }
      adoptableStartingRowId = precursors.length > 0 ? Number(precursors[0].id) : null;
    }
    // Mint from the shared role-launch primitive before account preflight.
    // Gateway-routed requests then carry this exact owner ID, while a refused
    // account route still exits before composition writes any launch artifact.
    const launchIdentity = {
      ...mintRoleLaunchIdentity(),
      ...(requestedSid ? { sid: requestedSid } : {}),
    };
    const accountPin = await resolveAccountPin(workspace, body.account ?? null, agent, launchIdentity.sid, false, model);
    if (accountPin.error) {
      return jsonRes({ status: 'error', error: accountPin.error }, 409);
    }
    // Feature + plan gating from the single source (roleConsumes / consumes).
    const consumes = roleConsumes(role, harnessSlug ?? '');
    if (consumes.feature === 'required' && !feature) {
      return jsonRes({ status: 'error', code: 'feature_required', error: `role '${role}' requires a feature (consumes.feature=required)` }, 400);
    }
    if (consumes.feature === 'required' && !harnessSlug) {
      return jsonRes({ status: 'error', code: 'harness_required', error: `role '${role}' consumes a feature — launch it against the feature's harness (--harness)` }, 400);
    }

    // Plan context for plan-consuming roles (scoper/reviewer: consumes.plan
    // !== 'none'). Honors the `consumes` single source the same way feature
    // does: only fetch+inject when the role actually consumes a plan AND one
    // was chosen. Best-effort — an unreadable plan just yields no section.
    let planContext: string | undefined;
    if (plan && consumes.plan !== 'none') {
      planContext = (await getPlanContextBySlug(plan).catch(() => null)) ?? undefined;
    }

    // directed-wake-honesty-and-spawn-handoff P-021/P-012: the INTERACTIVE launch's
    // call of the shared spawn/wake-hydration seam — the human-driven counterpart of
    // the autonomous path (operator-spawn → extraEnv.SPAWN_HANDOFF). Both paths bind
    // the source seam through productionSpawnHydrationDeps so they never diverge on
    // predecessor-handoff + roster + carry-note. NOTE: this path deliberately omits
    // `deliverTo`/`role`, so B2 slot-parked draining (P-023) does NOT fire here —
    // slot delivery is the AUTONOMOUS spawn's domain (the Queen parks for a
    // not-yet-spawned bee; delivered_to = its spawnId). Wiring it here needs the
    // session owner BEFORE buildRoleLaunchSpec mints `sid` (a small follow-up).
    // Harness-scoped: skipped for a workspace-level (no-harness) session. Gated on
    // SPAWN_HANDOFF_HYDRATION (default on); fully fail-soft so a hydration failure
    // never blocks the launch.
    let handoff: string | undefined;
    if (harnessSlug) {
      try {
        if (await getFlag(FLAGS.SPAWN_HANDOFF_HYDRATION, 'system')) {
          const hydration = await assembleSpawnHydration({
            harness: harnessSlug,
            featureId: feature ?? undefined,
            // Honor the role's `consumes.plan` contract for the handoff's plan SLICE,
            // exactly as the full planContext above does: a non-plan-consuming role
            // gets predecessor handoff + roster + carry-note, but no plan slice.
            planSlug: plan && consumes.plan !== 'none' ? plan : undefined,
            workItemId: feature ?? undefined,
            workspaceId: workspace,
            deps: productionSpawnHydrationDeps(),
            log: (m) => console.log(`[bootstrap-role] ${m}`),
          });
          if (hydration.text) handoff = hydration.text;
        }
      } catch (err) {
        console.warn(
          `[bootstrap-role] spawn-handoff hydration failed (degraded, launch continues): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Build the shared spec: role prompt + signed role-scoped MCP URL + cwd.
    let spec;
    try {
      spec = await buildRoleLaunchSpec({
        role,
        workspaceId: workspace,
        harnessSlug,
        ...(planContext ? { planContext } : {}),
        ...(handoff ? { handoff } : {}),
        operatorBaseUrl: new URL(req.url).origin,
        featureId: feature,
        contextSize,
        stack: body.stack?.map((ref) => ref.trim()) ?? null,
        expectedModelDefault: identityModelDefault,
        acceptedOperation: acceptedOperation && modelSelection
          ? { ...acceptedOperation, modelSelection } : acceptedOperation,
        launchIdentity,
      });
    } catch (e: any) {
      return jsonRes({ status: 'error', error: e?.message ?? 'role launch spec build failed' }, 400);
    }
    if (spec.sid !== launchIdentity.sid || spec.nativeSessionId !== launchIdentity.nativeSessionId) {
      return jsonRes({ status: 'error', code: 'role_identity_mismatch',
        error: 'role launch identity changed after account routing' }, 500);
    }
    // Stale-harness guard (owner 2026-06-23): a harness whose registered project
    // dir was deleted — classically a `/tmp` e2e test bed (e.g.
    // `/tmp/sched-e2e-test-bed`) — yields a cwd that no longer exists, so the
    // `.mcp.json` write below ENOENTs and the planner pane never opens (the
    // "write .mcp.json: ENOENT … /.mcp.json" failure the owner hit on "new
    // plan"). Fall back to the workspace root so the launch still works, and
    // warn so the stale registration is visible to clean up. Resolves the whole
    // class (any deleted harness dir), not one path.
    if (!existsSync(spec.cwd)) {
      const fallbackCwd = papercuspPathForWorkspace(workspace);
      console.warn(
        `[bootstrap-role] launch cwd "${spec.cwd}" does not exist (stale harness registration?); falling back to "${fallbackCwd}"`,
      );
      if (existsSync(fallbackCwd)) spec.cwd = fallbackCwd;
    }

    // Per-session coord/lock owner (P-022) — now MINTED BY THE LAUNCH-SPEC
    // PRIMITIVE (unify-launch-mechanics P-002), not here, so the one place that
    // signs the MCP URL also owns the identity: spec.sid === the URL's
    // `client=` param (EI-4) === PAPERCUSP_SID (below) === the codex-home baked
    // client. It's stored as coord_owner_id, the live-roster join key to
    // coord_presence.owner_id (adv-sessions-live-roster P-001).
    const sid = spec.sid;

    // named-su-agent-fleets P-009: resolve the chosen fleet (create-on-new-name +
    // membership env), mirroring bootstrap-su. Deferred until here because the fleet's
    // owner + leader is this session's coord owner id (sid), which the launch-spec mints
    // (D-002). Fail-soft: any error ⇒ empty env + a notice, never a throw.
    const fleetPin = await resolveFleet(workspace, {
      fleet: body.fleet,
      fleetRole: body.fleet_role,
      fleetName: body.fleet_name,
      ownerId: sid,
    });
    // WI-1408 (fleet-join-startup-assertion): mirrors bootstrap-su's guard — a role
    // launch that explicitly asked to join/create a fleet must never silently degrade
    // to an unfleeted member on a resolution hiccup. Fail loud instead of fail-soft.
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
    // WI-1893 (cluster-safe fleet stamp, mirrors bootstrap-su): append the DURABLE
    // membership fact at boot instead of the old in-memory setPendingFleet placement —
    // the pending map lived in ONE cluster worker and was lost when the agent's first
    // presence write landed on another (:3070 is node:cluster + SO_REUSEPORT), leaving
    // the agent fleet_slug=null and invisible to fleet:assignments. The fact + mig-430
    // triggers cover fact-first AND row-first ordering; fail LOUD per WI-1408.
    if (fleetPin.fleetSlug) {
      const stampErr = await stampFleetMembershipAtBoot({
        workspaceId: workspace,
        ownerId: sid,
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

    // Forced native session UUID for EXACT resumability (claude --session-id;
    // unify-launch-mechanics P-003 invariant d). Recording it as the adv row's
    // session_id lets wake-executor resume THIS conversation by uuid instead of
    // degrading to inbox — previously role sessions carried no native id and so
    // could not be woken-by-resume. claude-only: codex recovers its uuid from
    // the rollout, omp resumes by thread id.
    const nativeSessionId = backendFeatureGuard(agent, 'forced-native-session-id').supported
      ? spec.nativeSessionId
      : null;

    // launch-path-argv-reconstruction (WI-1343), extended to the role path (WI-1347):
    // this route has no `launch_argv` field in its body yet (the psu launcher's role
    // flow predates WI-1343 — roleBootstrapBody doesn't send one), so it's always a
    // server-side reconstruction from the resolved fields. `role` (not `profile`)
    // is what a role-scoped `psu --role=<role>` invocation actually carries.
    const launchArgv = reconstructPsuLaunchArgv({
      agent,
      model,
      modelSource,
      headless,
      role,
      stack: spec.stack,
      harnessSlug,
      planSlug: planContext ? plan : null,
      account: body.account?.trim() || null,
      fleet: body.fleet?.trim() || body.fleet_name?.trim() || null,
    });
    if (launchedBy) launchArgv.push(`--launched-by=${launchedBy}`);

    // Complete the canonical launcher's precursor rather than introducing a
    // second roster row. A lost adoption race must not create a duplicate.
    const label = feature ? `${role} · ${feature}` : (planContext ? `${role} · ${plan}` : role);
    let sessionId: number | null = null;
    if (adoptableStartingRowId != null) {
      const adopted = await adoptStartingTerminalLaunch({
        id: adoptableStartingRowId,
        sessionId: nativeSessionId,
        role,
        feature,
        planSlug: planContext ? plan : null,
        label,
        cwd: spec.cwd,
        mode: agent === 'omp' ? 'omp' : 'console',
        launchArgv,
      });
      if (!adopted) {
        return jsonRes({ status: 'error', code: 'role_launch_adoption_conflict',
          error: `owner_id ${sid} starting row ${adoptableStartingRowId} changed during bootstrap; refusing duplicate registration`,
        }, 409);
      }
      sessionId = adoptableStartingRowId;
    } else {
      sessionId = await recordAdvSession({
        workspaceId: workspace,
        role,
        feature,
        agent,
        planSlug: planContext ? plan : null,
        mode: agent === 'omp' ? 'omp' : 'console',
        cwd: spec.cwd,
        label,
        coordOwnerId: sid,
        launchArgv,
        ...(nativeSessionId ? { sessionId: nativeSessionId } : {}),
      });
    }
    incompleteBootstrapSessionId = sessionId;

    // A grant-bearing role identity must reach the same database-owned kernel
    // receipt as an SU identity. Merely compiling its prompt/artifact leaves
    // checkIdentityGrantKernel on the legacy ungoverned path. Persist before
    // returning a launch so the first tool call can only use the current grant
    // policy; a failed receipt is a failed launch, not an unrestricted worker.
    if (spec.specificationArtifact?.configuration?.grants != null) {
      const recorded = await recordSuLaunchSpec(sessionId, sid, {
        v: 1,
        workspaceId: workspace,
        harnessSlug,
        role,
        stack: spec.stack,
        specificationRevision: spec.specificationRevision,
        stateRevision: spec.stateRevision,
        specificationArtifact: spec.specificationArtifact,
        ...(spec.acceptedOperation ? { acceptedOperation: {
          kind: 'blueprint-operation-worker',
          workItemId: spec.acceptedOperation.workItemId,
          operationId: spec.acceptedOperation.operationId,
          specificationRevision: spec.acceptedOperation.specificationRevision,
          pin: spec.acceptedOperation.pin,
          identity: spec.acceptedOperation.identity,
          requiredTools: spec.acceptedOperation.requiredTools,
          ...(spec.acceptedOperation.modelPolicy ? {
            modelPolicy: spec.acceptedOperation.modelPolicy,
            modelSelection: spec.acceptedOperation.modelSelection,
          } : {}),
        } } : {}),
      });
      if (!recorded) {
        return jsonRes({ status: 'error', error: 'restricted role identity receipt was not persisted' }, 500);
      }
      try {
        const { requestSessionIdentityActivation } = await import('../../../agent-tools/coordination/control-anchor');
        await requestSessionIdentityActivation({
          ownerId: sid,
          workspaceId: workspace,
          revision: {
            specificationRevision: spec.specificationRevision,
            stateRevision: spec.stateRevision,
          },
          attribution: { actorId: sid, principalId: sid, sessionId: sid },
          source: 'launch',
        });
      } catch (error) {
        return jsonRes({ status: 'error', error: `restricted role identity activation failed: ${error instanceof Error ? error.message : String(error)}` }, 500);
      }
    }

    // EI-23204591840754750: role sessions use the same launcher supervisor beat
    // as SU sessions, but that beat can only keep an EXISTING presence row warm.
    // Stamp the row after recording the session so a role owner remains directly
    // addressable after the short recorded-session bootstrap rescue window. The
    // agent's own first coord call still refreshes this row and its liveness data.
    const presenceStampErr = await stampPresenceAtBoot({
      workspaceId: workspace,
      ownerId: sid,
      ownerLabel: feature ? `${role} · ${feature}` : (planContext ? `${role} · ${plan}` : role),
      harnessSlug,
      agentRole: role,
    });
    if (presenceStampErr) {
      process.stderr.write(
        `[bootstrap-role] presence stamp failed (non-fatal; first coord:orient can repair it): ${presenceStampErr}\n`,
      );
    }

    // Materialize the launch artifacts. claude/omp consume a `.mcp.json` +
    // a launch-context prompt file; codex (no --mcp-config /
    // --append-system-prompt flags) consumes a per-session CODEX_HOME whose
    // AGENTS.md is the role prompt and config.toml the role-scoped MCP. All
    // three carry the SAME signed role-scoped url (spec.mcpUrl).
    const sessionKey = sessionId ?? `role-${Date.now()}`;
    let mcpJsonPath = '';
    let promptFile = '';
    let codexHome: string | null = null;

    if (agent === 'codex') {
      try {
        const ch = writeRoleCodexHome({
          sessionKey,
          mcpUrl: spec.mcpUrl,
          promptText: spec.promptText,
          model,
          // The session's coordination identity → the activity-bridge hook reports
          // this worker's tool calls under it (codex bakes it; can't env-expand).
          sid,
          codexGatewayAccountId: accountPin.provider === 'codex' ? accountPin.accountId : null,
          // WI-3645: explicit-auto → the UNPINNED gateway provider block (header omitted;
          // the gateway auto-selects). False whenever a pin resolved or routing is off.
          codexGatewayAuto: accountPin.provider === 'codex' && !!accountPin.gatewayAuto,
          codexGatewayPriority: accountPin.provider === 'codex' ? role : null,
          headless,
          // Seed launch-dir trust so a fresh CODEX_HOME doesn't block at codex's
          // "Do you trust this directory?" boot prompt (role sessions are trusted).
          trustDir: spec.cwd,
        });
        codexHome = ch.codexHome;
        mcpJsonPath = ch.configPath; // config.toml — diagnostics
        promptFile = ch.agentsPath; // AGENTS.md — diagnostics
      } catch (e: any) {
        return jsonRes({ status: 'error', error: `write codex home: ${e?.message}` }, 500);
      }
    } else {
      // Write the signed role-scoped .mcp.json only into the per-session MCP
      // directory. A role launch must never materialize a signed, single-agent
      // config in spec.cwd: claude/omp can both discover project config there,
      // so a shared harness checkout would leak this session's identity to the
      // next launch. claude is pointed at this path via --mcp-config; roleFlow
      // copies the same bytes into OMP's isolated PI_CONFIG_DIR.
      try {
        mcpJsonPath = join(spec.sessionMcpDir, '.mcp.json');
        mkdirSync(spec.sessionMcpDir, { recursive: true });
        writeFileSync(mcpJsonPath, spec.mcpJsonContents, { mode: 0o600 });
      } catch (e: any) {
        return jsonRes({ status: 'error', error: `write session .mcp.json: ${e?.message}` }, 500);
      }

      // Write the role prompt to a launch-context file the launcher injects
      // as the system prompt (NOT the engineer playbook the *-su wrappers use).
      promptFile = launchContextPathFor(sessionKey);
      try {
        mkdirSync(launchContextDir(), { recursive: true });
        writeFileSync(promptFile, spec.promptText, { mode: 0o600 });
      } catch (e: any) {
        return jsonRes({ status: 'error', error: `write role prompt: ${e?.message}` }, 500);
      }
    }

    // EI-155: an interactive claude role session gets the SAME per-session,
    // transcript-isolated CLAUDE_CONFIG_DIR the SU path does (the role path
    // already COMPUTES spec.claudeConfigDir = sessionClaudeConfigDir(sid) but
    // never materialized it — a half-wired unify-launch-mechanics invariant).
    // It carries the lock/coord hooks (user-level ~/.claude/settings.json) +
    // onboarding/trust through, isolating only the transcript store; the role
    // MCP stays scoped via the launcher's --mcp-config --strict-mcp-config (the
    // symlinked .claude.json servers are ignored under strict). Best-effort.
    let claudeConfigDir: string | null = null;
    if (agent === 'claude') {
      try {
        claudeConfigDir = (await writeInteractiveClaudeConfig({
          sid,
          // WI-3280: park the role prompt so the SessionStart recovery hook can
          // re-deliver it if claude's self-re-exec drops the launch argv.
          recovery: { playbookPath: promptFile || null, nativeSessionId },
          // EI-16574: pre-trust this launch's cwd so a brand-new project
          // directory can't wedge a headless role spawn forever on an
          // external-CLAUDE.md-imports / trust-dialog TTY prompt.
          cwd: spec.cwd,
        })).configDir;
      } catch (e: any) {
        process.stderr.write(`[bootstrap-role] claude config-dir materialize failed (non-fatal): ${e?.message}\n`);
      }
    }

    // Materialize this harness's + the workspace's saved prompts into the
    // locations this client reads, so the session starts with the `/name`
    // commands available (plan saved-prompts-cross-client; interactive only,
    // D-004). Codex needs them written into its ephemeral per-session home;
    // claude/omp read the on-disk .claude/commands files (kept fresh on save,
    // refreshed here belt-and-suspenders). Best-effort — a projection hiccup
    // must never block a launch.
    try {
      if (agent === 'codex' && codexHome) {
        if (harnessSlug) await materializeCodexPrompts(codexHome, workspace, harnessSlug);
        // Slash exposure (slash-exposure-tool-catalog-2026-06-12 P-009):
        // Codex doesn't surface MCP prompts as slash commands, so the
        // session-visible (role-filtered) tool catalog is materialized as
        // prompt FILES — the same walk tools/list serves this role.
        const r = await emitCodexSlashToolPrompts(codexHome, role as never);
        process.stderr.write(
          `[bootstrap-role] slash tool prompts: ${r.written} written, ${r.pruned} pruned in ${Math.round(r.ms)}ms\n`,
        );
      } else {
        await materializeWorkspacePrompts(workspace);
        if (harnessSlug) await materializeHarnessPrompts(workspace, harnessSlug);
      }
    } catch (e: any) {
      // stderr (not console.*) so the vitest fail-on-console guard stays green.
      process.stderr.write(`[bootstrap-role] saved-prompts materialize failed (non-fatal): ${e?.message}\n`);
    }

    // code-intelligence-routing-lsp-gitnexus-2026-08-20 P-021 (D-013): may this omp
    // role session KEEP its native `lsp` builtin? Resolve server-side and thread
    // via envelopeEnv because psu-launcher.mjs is bare node and cannot read a TS
    // flag. The decision itself — including the local-model TIER
    // GATE that is what makes OMP_NATIVE_LSP_BUILTIN safe to ship default-ON — lives
    // in ONE place, mayKeepOmpNativeLsp, shared with bootstrap-su. Read its header
    // before changing anything here. Fail-soft ⇒ off ⇒ the launcher strips the
    // builtin, byte-identical to the pre-P-021 hard-coded `--no-lsp`.
    let ompNativeLsp = false;
    try {
      if (agent === 'omp') {
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

    const result: BootstrapRoleResult = {
      status: 'ok',
      sessionId,
      role,
      agent,
      model,
      workspaceId: workspace,
      harnessSlug,
      feature,
      planSlug: planContext ? plan : null,
      cwd: spec.cwd,
      promptFile,
      mcpJsonPath,
      codexHome,
      accountNotice: accountPin.notice,
      fleetNotice: fleetPin.notice,
      fleetSlug: fleetPin.fleetSlug,
      fleetRole: fleetPin.fleetRole,
      contextSize: spec.contextSize,
      specificationRevision: spec.specificationRevision,
      stateRevision: spec.stateRevision,
      compositionSource: spec.compositionSource,
      envelopeEnv: {
        PAPERCUSP_AGENT: agent,
        ...(modelSource ? { PAPERCUSP_MODEL_SOURCE: modelSource } : {}),
        PAPERCUSP_ROLE: role,
        // deriveAgentRole reads this durable fine-grained key on the role's
        // first self-registration; keep it aligned with the boot-time stamp.
        PAPERCUSP_AGENT_ROLE: role,
        PAPERCUSP_SPECIFICATION_REVISION: spec.specificationRevision,
        PAPERCUSP_STATE_REVISION: spec.stateRevision,
        // P-022: per-session coord/lock owner. The lock hooks (claude
        // user-level; codex in the role home's settings.json) read this, so a
        // session's calls + hooks share one owner and concurrent sessions
        // don't collide. Same value recorded as adv_sessions.coord_owner_id.
        PAPERCUSP_SID: sid,
        ...(launchedBy ? { PAPERCUSP_LAUNCHED_BY: launchedBy } : {}),
        // P-021/D-013 — see the ompNativeLsp resolution above. Set-when-true, so
        // ABSENT is the safe reading: the launcher strips omp's native `lsp`
        // builtin unless this explicitly says it may keep it.
        ...(ompNativeLsp ? { PAPERCUSP_OMP_NATIVE_LSP: '1' } : {}),
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
        ...accountPin.env,
        // named-su-agent-fleets P-009: fold the fleet membership env (PAPERCUSP_FLEET_SLUG /
        // PAPERCUSP_FLEET_ROLE) right next to the account pin — the presence-write path reads
        // those exact var names. Empty when no fleet was chosen (byte-identical to today).
        ...fleetPin.env,
        ...(claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeConfigDir } : {}),
        ...(feature ? { PAPERCUSP_FEATURE_ID: feature } : {}),
        ...(sessionId != null ? { PAPERCUSP_ADV_SESSION_ID: String(sessionId) } : {}),
        // claude exact-resume: the launcher forces `--session-id <this>` so the
        // session's conversation id is known up-front and wake-executor resumes
        // EXACTLY it (never `--continue`'s most-recent-in-cwd peer). P-003 inv d.
        ...(nativeSessionId ? { PAPERCUSP_NATIVE_SESSION_ID: nativeSessionId } : {}),
      },
    };
    if (bootstrapLedgerKey) {
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
      // If any later artifact/identity write fails, close the exact row before
      // releasing the claim. A same-key retry must not race a PID-less session.
      if (bootstrapClaimWon && !bootstrapCompleted) {
        let partialRowTerminal = true;
        if (incompleteBootstrapSessionId != null) {
          try {
            await markAdvSessionEnded(incompleteBootstrapSessionId, null, 'reconciler', {
              throwOnError: true,
            });
          } catch (error) {
            partialRowTerminal = false;
            console.warn(
              `[bootstrap-role] incomplete session ${incompleteBootstrapSessionId} could not be terminalized; ` +
              `retaining bootstrap idempotency claim: ${(error as Error)?.message ?? error}`,
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

export default [options, post];
