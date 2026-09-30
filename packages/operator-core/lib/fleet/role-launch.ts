/**
 * fleet/role-launch — THE one answer to "what will this role launch as?"
 *
 * Plan role-model-one-answer-2026-09-03, P-001/P-003.
 *
 * Before this module the answer was assembled across five places that each knew
 * part of it: `launch-blueprint.ts` (per-role model, per-role backend, composed
 * body), `model-tiers.ts` (the tier menu + clamps), `agent-config.ts` (the stored
 * config and its env mirror), `owner-steering.ts` (the 👑-tab session override)
 * and the `/invoke` route (the downstream fallback). Nothing owned the whole
 * question, so nothing could report it — and a per-role model that was set
 * correctly could be silently dropped on the floor with no surface saying so.
 *
 * Measured cost of that (2026-09-03 00:32Z→01:27Z): nine consecutive
 * release-fixer launches spawned on `codex`/`gpt-5.6-sol` and died instantly on a
 * usage wall, while BOTH `models['release-fixer'] = 'claude-opus-5:xhigh'` AND
 * `roleBackends['release-fixer'] = 'claude-code'` were already set. The launch
 * path never consulted `models[role]` at all — only the tier menu — so the
 * explicit answer was inert, and because the backend is derived from the model
 * spec downstream, losing the model silently lost the backend with it.
 *
 * ── The precedence, in one place ──────────────────────────────────────────────
 *
 * MODEL (`source`):
 *   1. `per-role`          — `cfg.models[role]`. THE ANSWER. Specific beats
 *                            general: the tier menu's family/floor/ceiling math
 *                            gets no vote over an explicit per-role model (D-001).
 *   2. `tier-menu`         — `resolveRoleOwnModelSpec` against the effective
 *                            (session-override > workspace) menu + ceilings.
 *   3. `committed-default` — nothing configured; `roleModelDefault(role)` stands
 *                            and the spawn carries no model override at all.
 *
 * BACKEND (`backendSource`) — it RIDES WITH THE MODEL, it is not re-guessed:
 *   1. `tier-row`      — the winning tier row's own `backend` field. A tier that
 *                        declares its CLI is the most direct statement there is.
 *   2. `model-catalog` — the model vocabulary knows this id's provider.
 *   3. `model-shape`   — the id is unmistakably provider-shaped but not enumerated
 *                        (`claude-opus-5`, `openai-codex/…`). Labelled, never silent.
 *   4. `role-backends` — `cfg.roleBackends[role]`, the FALLBACK used only when no
 *                        per-role model is set (P-003). An explicit model answers
 *                        the backend question itself; `roleBackends` is what you
 *                        reach for when there is no model to answer it.
 *   5. `inherit`       — nothing determines it; the host's own agent command wins.
 *
 * A `roleBackends[role]` that DISAGREES with the winning backend is never
 * silently applied and never silently discarded — it is reported on `conflict`,
 * which is what P-005's compose-time warning and P-004's readout both render.
 *
 * Pure and synchronous: callers supply `cfg` + `steering`. `resolveRoleLaunchLive`
 * at the bottom is the one seam that reads them, so a long-running process
 * resolves against CURRENT config rather than a stale `process.env` mirror.
 */
import {
  backendForModelSpec,
  DEFAULT_MODEL_TIERS,
  type AgentBackend,
  type ModelTier,
} from '../agent-config-constants';
import { effectiveTierConfig, resolveRoleOwnModelSpec } from './model-tiers';
import { roleModelDefault } from '@papercusp/orchestrator/role-models';

/** Which rule decided the MODEL. */
export type RoleLaunchModelSource = 'per-role' | 'tier-menu' | 'committed-default';

/** Which rule decided the BACKEND. Ordered strongest → weakest. */
export type RoleLaunchBackendSource =
  | 'tier-row'
  | 'model-catalog'
  | 'model-shape'
  | 'role-backends'
  | 'inherit';

/** A configured `roleBackends[role]` the resolved backend overrules. Present ONLY
    when the two genuinely disagree — a matching pair is not a conflict. */
export interface RoleLaunchConflict {
  /** What `roleBackends[role]` says. */
  configured: AgentBackend;
  /** What this launch will ACTUALLY run on. */
  effective: AgentBackend;
  /** One line naming the losing side and how to align it. */
  note: string;
}

export interface RoleLaunch {
  role: string;
  /**
   * The spec to thread into the spawn as `PAPERCUSP_SPAWN_MODEL`, or `null` when
   * nothing overrides the role's committed default (leave the spawn untouched —
   * an un-steered launch must stay byte-identical to today's).
   */
  spawnModel: string | null;
  /** The spec that will ACTUALLY run: `spawnModel` ?? the committed default.
      `''` when the role has no committed default either (→ the CLI's own). */
  model: string;
  source: RoleLaunchModelSource;
  /** The backend to thread as `PAPERCUSP_SPAWN_BACKEND`; `null` = inherit the
      host's agent command. */
  backend: AgentBackend | null;
  backendSource: RoleLaunchBackendSource;
  /** One human-readable line: which rule won, and why. Rendered by the readout
      (P-004) and the compose-time warning (P-005) so both derive from THIS
      computation instead of re-deriving a second copy of it. */
  why: string;
  conflict: RoleLaunchConflict | null;
}

/** The config slice this resolver reads — a structural subset of `AgentConfig`
    so callers may pass the whole config without this module importing it. */
export interface RoleLaunchConfig {
  models?: Record<string, string> | null;
  roleBackends?: Record<string, AgentBackend> | null;
  tiers?: readonly ModelTier[] | null;
  tierCeilings?: Record<string, string> | null;
}

/** The owner's 👑-tab SESSION steering override, as `effectiveTierConfig` takes it. */
export interface RoleLaunchSteering {
  modelTiers?: readonly ModelTier[] | null;
  tierCeilings?: Record<string, string> | null;
}

/** The tier row a resolved spec came from, for its declared `backend`. Exact-spec
    match against the effective menu (the same rows `resolveRoleOwnModelSpec` chose
    from), falling back to the committed menu when the owner defined none. */
function tierRowForSpec(spec: string, tiers: readonly ModelTier[] | undefined): ModelTier | undefined {
  const menu = tiers && tiers.length > 0 ? tiers : DEFAULT_MODEL_TIERS;
  return menu.find((t) => t.spec === spec);
}

/**
 * Resolve `{ model, backend, source, why }` for `role` — the single seam every
 * launch path calls. Pure; see the module header for the full precedence.
 */
export function resolveRoleLaunch(
  role: string,
  input: { cfg?: RoleLaunchConfig | null; steering?: RoleLaunchSteering | null } = {},
): RoleLaunch {
  const cfg = input.cfg ?? null;
  const committed = roleModelDefault(role) ?? '';
  const configuredBackend = cfg?.roleBackends?.[role] ?? null;

  // ── MODEL ────────────────────────────────────────────────────────────────
  const explicit = cfg?.models?.[role]?.trim();
  const eff = effectiveTierConfig(
    { tiers: cfg?.tiers ?? undefined, tierCeilings: cfg?.tierCeilings ?? undefined },
    input.steering ?? null,
  );

  let spawnModel: string | null = null;
  let source: RoleLaunchModelSource;
  let modelWhy: string;

  if (explicit) {
    spawnModel = explicit;
    source = 'per-role';
    modelWhy = `models['${role}'] = '${explicit}' — an explicit per-role model is the answer; the tier menu gets no vote`;
  } else {
    const fromTier = resolveRoleOwnModelSpec(role, eff);
    if (fromTier) {
      spawnModel = fromTier;
      source = 'tier-menu';
      modelWhy = `tier menu resolved '${fromTier}' for '${role}' (no models['${role}'] set)`;
    } else {
      source = 'committed-default';
      modelWhy = committed
        ? `no per-role model and no tier override — the committed default '${committed}' stands`
        : `no per-role model, no tier override and no committed default for '${role}' — the CLI's own default runs`;
    }
  }

  const model = spawnModel ?? committed;

  // ── BACKEND — it rides with the model (P-003) ────────────────────────────
  let backend: AgentBackend | null = null;
  let backendSource: RoleLaunchBackendSource = 'inherit';
  let backendWhy: string;

  const tierRow = source === 'tier-menu' && spawnModel ? tierRowForSpec(spawnModel, eff.tiers) : undefined;
  const fromModel = backendForModelSpec(model);

  if (tierRow?.backend) {
    backend = tierRow.backend;
    backendSource = 'tier-row';
    backendWhy = `backend '${backend}' declared by tier row '${tierRow.name}'`;
  } else if (source !== 'committed-default' && fromModel) {
    // A CHOSEN model answers the backend question itself. "Chosen" is the load-bearing
    // word: an owner typing `models[role]`, or a tier menu resolving one, is a statement
    // about how this role should run. A COMMITTED DEFAULT is not — it is the code-level
    // floor, and the host's own agent command outranks it (see below).
    backend = fromModel.backend;
    backendSource = fromModel.evidence;
    backendWhy = `backend '${backend}' rides with model '${model}' (${fromModel.evidence})`;
  } else if (isForcedCodex(fromModel)) {
    // The ONE case where a committed default overrules configuration: a Codex-only
    // spec handed to the claude/omp binary is fatal at launch and near-silent in the
    // logs (WI-4640 — kettle@papercusp, 2026-07-16, hard-downed by exactly this).
    backend = 'codex';
    backendSource = fromModel!.evidence;
    backendWhy = `backend 'codex' forced by Codex-only model '${model}' — no other CLI can run it`;
  } else if (configuredBackend) {
    // No model was CHOSEN for this role, so the configured backend is the answer.
    backend = configuredBackend;
    backendSource = 'role-backends';
    backendWhy = `backend '${backend}' from roleBackends['${role}'] (no per-role model to carry one)`;
  } else {
    // Deliberately NOT derived from the committed default. `inferBackendFromModelSpec`
    // has always kept Claude/OMP aliases inheriting the host's configured command, and
    // that is the behaviour a host which exports AGENT_CMD depends on: pinning a
    // backend here would silently overrule an operator's `AGENT_CMD='omp -p'` for every
    // role that merely has a committed floor. Only a CHOICE (above) or a Codex-only
    // spec (which nothing else can run) may pin it.
    backendWhy = model
      ? `no chosen model and no roleBackends['${role}'] — inheriting the host's agent command (committed default '${model}' does not pin a CLI)`
      : `no model and no backend configured — inheriting the host's agent command`;
  }

  // ── CONFLICT — never silently applied, never silently discarded ──────────
  const conflict: RoleLaunchConflict | null =
    configuredBackend && backend && configuredBackend !== backend
      ? {
          configured: configuredBackend,
          effective: backend,
          note:
            `roleBackends['${role}'] = '${configuredBackend}' but this launch runs on '${backend}' ` +
            `(${backendWhy}). The model decides the CLI, so the configured backend is IGNORED — ` +
            `align models['${role}'] and roleBackends['${role}'] in /settings/agent rather than ` +
            `inverting this precedence (WI-4640).`,
        }
      : null;

  return {
    role,
    spawnModel,
    model,
    source,
    backend,
    backendSource,
    why: `${modelWhy}; ${backendWhy}`,
    conflict,
  };
}

/** A Codex-only spec FORCES its backend even over an explicit `roleBackends`
    preference — pairing a Codex model with the claude/omp binary is fatal at
    launch and near-silent in the logs (WI-4640). */
function isForcedCodex(fromModel: ReturnType<typeof backendForModelSpec>): boolean {
  return fromModel?.backend === 'codex';
}

/**
 * `resolveRoleLaunch` against the CURRENT stored config + owner steering.
 *
 * This read is the point: `process.env.AGENT_MODELS` / `AGENT_ROLE_BACKENDS` are
 * mirrors refreshed only when THIS process wrote the config or booted, so a
 * long-running scheduler (bg-host fires the release-fixer from green-checkpoint)
 * can serve a days-old snapshot. Fail-soft — an unreadable config resolves the
 * role against its committed default rather than blocking a launch.
 */
export async function resolveRoleLaunchLive(
  role: string,
  opts: { workspaceId?: string; installSlug?: string } = {},
): Promise<RoleLaunch> {
  let cfg: RoleLaunchConfig | null = null;
  let steering: RoleLaunchSteering | null = null;
  try {
    const [{ readAgentConfig }, { getOwnerSteering }] = await Promise.all([
      import('../agent-config'),
      import('../owner-steering'),
    ]);
    [cfg, steering] = await Promise.all([
      readAgentConfig().catch(() => null),
      opts.workspaceId && opts.installSlug
        ? getOwnerSteering(opts.workspaceId, opts.installSlug).catch(() => null)
        : Promise.resolve(null),
    ]);
  } catch {
    /* fail-soft: resolve against the committed default */
  }
  return resolveRoleLaunch(role, { cfg, steering });
}
