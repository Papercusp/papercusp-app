/**
 * fleet/model-tiers — resolve a tier NAME to a model spec, clamped to the
 * role's safety bounds (queen-model-tier-selection-2026-06-11 P-002).
 *
 * The propose/dispose split for per-task model selection: the USER defines the
 * tier menu (AgentConfig.tiers, ordered weakest → strongest) and the per-role
 * ceilings (AgentConfig.tierCeilings); the QUEEN only picks a tier name from
 * that menu. Resolution clamps her pick to [role floor, role ceiling]:
 *
 *   - floor  — derived, not configured: the rank of the role's resolved
 *     default model (AGENT_MODELS[role] → ROLE_MODEL_DEFAULTS floor) in the
 *     tier list. A tier pick may ESCALATE a role above its default but never
 *     downgrade it below — the EI-7/EI-286 scar tissue (a queen silently
 *     dropped to haiku drifts into bash and fabricates evidence) is exactly
 *     why a "too cheap" pick must clamp up rather than apply.
 *   - ceiling — the user's budget envelope per role (tierCeilings[role]);
 *     absent = the strongest tier is allowed.
 *
 * Clamping is LOUD (the result names which bound clamped and why) but never
 * an error — only an unknown tier name rejects, since that's a bad input the
 * caller should fix, not a judgment to silently reinterpret.
 */
import { DEFAULT_MODEL_TIERS, defaultCompactionLimitForTier, type ModelTier } from '../agent-config-constants';
import { roleModelDefault } from '@papercusp/orchestrator/role-models';

/** The `tier` reported when a role is frozen on an OFF-MENU default (WI-7340):
    no menu tier applies, so naming one would misreport what the spawn runs at.
    Pairs with `clamped:'floor'` — never a name a caller may pass IN. */
export const OFF_MENU_TIER = 'role-default';

export interface TierResolution {
  ok: true;
  /** The model spec to thread into the spawn (PAPERCUSP_SPAWN_MODEL). */
  spec: string;
  /** The tier the spawn actually runs at (post-clamp). */
  tier: string;
  /** The tier that was asked for. */
  requestedTier: string;
  /** Backend the resolved tier pins (PAPERCUSP_SPAWN_BACKEND). Absent =
      inherit the host's agent command. Comes from the RESOLVED tier — a
      clamp adopts the clamped-to tier's backend along with its spec. */
  backend?: string;
  /** The resolved tier's effective soft compaction limit (tokens) — the tier's
      explicit value, else the resolved spec's model-derived default
      (context-trimming-tiers D-001/D-002). Threaded to the spawn as
      PAPERCUSP_SPAWN_COMPACTION_LIMIT; the compliance watchdog seeds the
      model-derived default for sessions that never receive it. */
  compactionLimit: number;
  /** Set when the pick was clamped, with the bound that did it. */
  clamped?: 'floor' | 'ceiling';
  /** Human-readable note on why the clamp happened (for the spawn log/row). */
  note?: string;
}

export interface TierError {
  ok: false;
  error: string;
}

/** The model id part of a `<modelId>[:<effort>]` spec (effort stripped). */
export function specModelId(spec: string): string {
  const trimmed = spec.trim();
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon <= 0) return trimmed;
  const suffix = trimmed.slice(lastColon + 1);
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(suffix)
    ? trimmed.slice(0, lastColon)
    : trimmed;
}

/** The COMPARISON key for model-FAMILY checks. Known Claude aliases/versioned
    ids collapse to their capability family (`sonnet` and `sonnet-5` are the
    same current Claude family); unknown/cross-provider ids remain exact. The
    `[1m]` marker changes the WINDOW, not the model. This keeps committed role
    floors compatible with the stable bare aliases in DEFAULT_MODEL_TIERS even
    when ROLE_MODEL_DEFAULTS pins the current versioned id (EI-7/EI-286). */
export function specFamilyKey(spec: string): string {
  const id = specModelId(spec).replace(/\[1m\]/gi, '').toLowerCase();
  const modelClass = specModelClass(spec);
  return modelClass === 'other' ? id : modelClass;
}

/** Ordered effort strength for same-family own-model comparisons. An absent
    effort is the CLI default and therefore below every explicit effort. */
function specEffortRank(spec: string): number {
  const suffix = spec.trim().slice(spec.trim().lastIndexOf(':') + 1).toLowerCase();
  return ({ low: 1, medium: 2, high: 3, xhigh: 4, max: 5 } as const)[suffix as 'low' | 'medium' | 'high' | 'xhigh' | 'max'] ?? 0;
}

/** The role's resolved DEFAULT spec — what it runs with no tier: the
    user-level AGENT_MODELS env entry, else the committed floor. Empty when
    the role has neither (→ the CLI default; no floor protection possible). */
export function roleDefaultSpec(role: string): string {
  const raw = process.env.AGENT_MODELS;
  if (raw) {
    try {
      const map = JSON.parse(raw) as Record<string, unknown>;
      const v = map?.[role];
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch {
      /* malformed AGENT_MODELS — fall through to the committed default */
    }
  }
  return roleModelDefault(role) ?? '';
}

/** Rank of the first tier whose model FAMILY matches `spec`'s ([1m]-marker
    insensitive — see `specFamilyKey`), or -1. */
function tierRankOfSpec(tiers: readonly ModelTier[], spec: string): number {
  if (!spec) return -1;
  const key = specFamilyKey(spec);
  return tiers.findIndex((t) => specFamilyKey(t.spec) === key);
}

/** EXPAND-phase rows (WI-2932 pot-rename): owner-steering / agent-config
 *  `tierCeilings` (and `modelOverrides`) rows persisted BEFORE the rename still
 *  key on the old role ids. Canonical key first, then the legacy alias. DELETE
 *  this map when the S2 config-key migration rewrites the stored rows. */
/** A role's configured tier ceiling. */
export function roleTierCeiling(
  tierCeilings: Record<string, string> | undefined,
  role: string,
): string | undefined {
  const raw = tierCeilings?.[role];
  const v = raw?.trim();
  return v ? v : undefined;
}

/**
 * Resolve `tier` for `role` against the user's menu + bounds. Pass the
 * AgentConfig-stored `tiers`/`tierCeilings` (empty → DEFAULT_MODEL_TIERS /
 * no ceilings). Unknown tier name → error listing the valid menu; a pick
 * outside [floor, ceiling] clamps to the violated bound with a note.
 */
export function resolveTierSpec(opts: {
  tier: string;
  role: string;
  tiers?: readonly ModelTier[];
  tierCeilings?: Record<string, string>;
}): TierResolution | TierError {
  const tiers = opts.tiers && opts.tiers.length > 0 ? opts.tiers : DEFAULT_MODEL_TIERS;
  const requested = opts.tier.trim().toLowerCase();
  let idx = tiers.findIndex((t) => t.name.toLowerCase() === requested);
  if (idx < 0) {
    return {
      ok: false,
      error: `unknown tier "${opts.tier}" — valid tiers (weakest→strongest): ${tiers.map((t) => t.name).join(', ')}`,
    };
  }

  let clamped: TierResolution['clamped'];
  let note: string | undefined;

  const roleFloorSpec = roleDefaultSpec(opts.role);
  const floorIdx = tierRankOfSpec(tiers, roleFloorSpec);

  // OFF-LADDER FLOOR (WI-7340). `tierRankOfSpec` returns -1 for two DIFFERENT
  // reasons and they must not be collapsed:
  //   (a) the role has NO default at all (roleFloorSpec === '') — there is
  //       genuinely no floor to enforce, so any pick resolves unclamped;
  //   (b) the role HAS a default, but its model family is absent from this
  //       menu (e.g. a role pinned to a cross-provider model while the menu
  //       lists only claude tiers).
  // In case (b) the floor is real but the MENU cannot rank it, so the old
  // `floorIdx >= 0` gate skipped the clamp entirely and let ANY pick through —
  // including the cheapest. That silently defeated the never-downgrade
  // invariant for exactly the role it exists to protect: one whose default was
  // deliberately raised (EI-7/EI-286 — every committed role default here is
  // opus:xhigh precisely because a wrong call has fleet-wide blast radius).
  //
  // Menu rank is not the only ranking available, though. Where BOTH specs are
  // known Claude classes we can still order them (haiku < sonnet < opus) and
  // catch a real downgrade; that is the dangerous half. Freezing on EVERY
  // unrankable floor instead would break the owner's own-model lever, because
  // a small hand-written menu routinely omits the role's default family: `cup`
  // defaults to sonnet, so the one-row menu [standard: opus:xhigh] that exists
  // to RAISE it also lands here (floorIdx === -1) and would be refused as if it
  // were a downgrade. Cross-provider picks stay allowed for the same reason
  // resolveRoleOwnModelSpec returns them unchanged: a spec from another
  // provider is explicit owner intent, not a silent slide.
  //
  // So: clamp only a DEMONSTRABLE downgrade; otherwise resolve normally but say
  // the floor went unenforced, which is what makes the remaining gap loud
  // rather than invisible.
  if (roleFloorSpec && floorIdx < 0) {
    const floorRank = modelClassRank(roleFloorSpec);
    const pickRank = modelClassRank(tiers[idx].spec);
    if (floorRank > 0 && pickRank > 0 && pickRank < floorRank) {
      return {
        ok: true,
        spec: roleFloorSpec,
        tier: OFF_MENU_TIER,
        requestedTier: requested,
        // Derived from the role's OWN default spec — there is no menu row to
        // take a contextWindow from, which is the point of the frozen result.
        compactionLimit: defaultCompactionLimitForTier({ spec: roleFloorSpec }),
        clamped: 'floor',
        note: `role "${opts.role}" default "${roleFloorSpec}" is not on the configured tier menu (${tiers.map((t) => t.name).join(', ')}), and tier "${requested}" (${tiers[idx].spec}) is a WEAKER model class — the role stays on its own default (a role never silently downgrades, EI-7/EI-286). Steer an off-menu role via AGENT_MODELS.`,
      };
    }
    note = `role "${opts.role}" default "${roleFloorSpec}" is not on the configured tier menu (${tiers.map((t) => t.name).join(', ')}), so the never-downgrade floor could NOT be enforced by menu rank; tier "${requested}" (${tiers[idx].spec}) was allowed because it is not a demonstrably weaker model class.`;
  }

  // Ceiling, then floor — so when the two conflict (ceiling configured BELOW
  // the role's default) the floor wins: running at the role's default is what
  // happens with no tier at all, so a ceiling can never force a downgrade.
  const ceilingName = roleTierCeiling(opts.tierCeilings, opts.role)?.toLowerCase();
  if (ceilingName) {
    const ceilIdx = tiers.findIndex((t) => t.name.toLowerCase() === ceilingName);
    // An unknown ceiling name is a config bug — ignore it (no ceiling) rather
    // than guess; the settings UI validates names on save.
    if (ceilIdx >= 0 && idx > ceilIdx) {
      idx = ceilIdx;
      clamped = 'ceiling';
      note = `tier "${requested}" exceeds role "${opts.role}" ceiling "${tiers[ceilIdx].name}" — clamped down`;
    }
  }

  // floorIdx < 0 can only mean the EMPTY-default case (a) here — the off-ladder
  // case (b) returned above — so this stays the plain "rankable floor" clamp.
  if (floorIdx >= 0 && idx < floorIdx) {
    idx = floorIdx;
    clamped = 'floor';
    note = `tier "${requested}" is below role "${opts.role}" default floor "${tiers[floorIdx].name}" — clamped up (a role never silently downgrades, EI-7/EI-286)`;
  }

  return {
    ok: true,
    spec: tiers[idx].spec,
    tier: tiers[idx].name,
    requestedTier: requested,
    ...(tiers[idx].backend ? { backend: tiers[idx].backend } : {}),
    compactionLimit: tiers[idx].compactionLimit ?? defaultCompactionLimitForTier(tiers[idx]),
    ...(clamped ? { clamped } : {}),
    // Emitted independently of `clamped`: an off-menu floor that could NOT be
    // enforced by rank produces a note with no clamp, and that combination is
    // the whole point — the gap is reported instead of passing silently.
    ...(note ? { note } : {}),
  };
}

/** Coarse capability rank of a spec's model CLASS — haiku < sonnet < opus, and
    0 for `other` meaning NOT COMPARABLE (a cross-provider model, whose strength
    relative to the Claude ladder this module deliberately does not guess).
    Only ever used to detect a demonstrable DOWNGRADE; a 0 on either side means
    "no verdict", never "weakest". */
function modelClassRank(spec: string): number {
  const cls = specModelClass(spec);
  return cls === 'haiku' ? 1 : cls === 'sonnet' ? 2 : cls === 'opus' ? 3 : 0;
}

/** The coarse model CLASS of a spec — a local mirror of the governor's `modelClassOf` so model-tiers
 *  needn't import the lower governor lib. Used by the opus-budget downgrade (B-GW-4). */
export function specModelClass(spec: string): 'opus' | 'sonnet' | 'haiku' | 'other' {
  const id = specModelId(spec).toLowerCase();
  if (id.includes('opus')) return 'opus';
  if (id.includes('sonnet')) return 'sonnet';
  if (id.includes('haiku')) return 'haiku';
  return 'other';
}

export interface OpusDowngrade {
  /** True only when an OPUS spec was actually pulled back to a non-opus (sonnet) spec. */
  downgraded: boolean;
  /** The spec to run — the sonnet target when downgraded, else `currentSpec` unchanged. */
  spec: string;
  /** The tier name to record — the resolved sonnet tier when downgraded, else `currentTier`. */
  tier: string | null;
  /** The resolved tier's backend, set only when the downgrade adopted one. */
  backend?: string;
  /** The downgraded-to tier's effective soft compaction limit, set only on a real
      downgrade (the spec — and so the window — changed; context-trimming-tiers). */
  compactionLimit?: number;
  /** The original opus spec, set only when an actual downgrade happened (for the log / nursery row). */
  from?: string;
}

/**
 * Pull an OPUS tier escalation back to sonnet under fleet opus-budget pressure (B-GW-4 —
 * inference-gateway-robustness-audit-2026-06-20), respecting the role floor. ONLY acts when
 * `currentSpec` is an opus class; re-resolves to the menu's sonnet tier through `resolveTierSpec`, so
 * the existing floor-clamp guarantees a role whose OWN default is opus is never dropped below it
 * (EI-7/EI-286) — in that case `downgraded` is false and the opus spec stands. The downgrade target
 * is the STRONGEST menu tier whose spec runs sonnet (the smallest safe step down), falling back to
 * the committed `standard` tier when a custom menu has no sonnet entry. Pure.
 */
export function downgradeOpusTierForBudget(opts: {
  currentSpec: string;
  currentTier: string | null;
  role: string;
  tiers?: readonly ModelTier[];
  tierCeilings?: Record<string, string>;
}): OpusDowngrade {
  const unchanged: OpusDowngrade = { downgraded: false, spec: opts.currentSpec, tier: opts.currentTier };
  if (specModelClass(opts.currentSpec) !== 'opus') return unchanged; // nothing to shed
  const menu = opts.tiers && opts.tiers.length > 0 ? opts.tiers : DEFAULT_MODEL_TIERS;
  // The downgrade TARGET: the strongest menu tier that runs sonnet (smallest safe step down from
  // opus). Fall back to the committed 'standard' tier when a custom menu has no sonnet entry.
  const sonnetTiers = menu.filter((t) => specModelClass(t.spec) === 'sonnet');
  const targetTierName = sonnetTiers.length > 0 ? sonnetTiers[sonnetTiers.length - 1].name : 'standard';
  const r = resolveTierSpec({ tier: targetTierName, role: opts.role, tiers: opts.tiers, tierCeilings: opts.tierCeilings });
  if (!r.ok) return unchanged; // unknown target (no 'standard' in a custom menu) — leave opus as-is
  // The floor-clamp may have pulled the target back UP to opus (the role's OWN floor is opus) → no
  // real downgrade; keep the opus spec (the floor invariant, for free).
  if (specModelClass(r.spec) === 'opus') return unchanged;
  return {
    downgraded: true,
    spec: r.spec,
    tier: r.tier,
    backend: r.backend,
    compactionLimit: r.compactionLimit,
    from: opts.currentSpec,
  };
}

/**
 * The EFFECTIVE tier config for a spawn: the owner's 👑-tab SESSION override
 * (queen-steering-panel D-006) takes precedence over the workspace agent-config
 * default (precedence: session override > workspace default > committed default,
 * the last via `resolveTierSpec`'s DEFAULT_MODEL_TIERS fallback). Pure.
 *
 * The two fields compose DIFFERENTLY, on purpose:
 *
 *   - `tiers` is a MENU whose ORDER is the strength ranking the floor/ceiling
 *     clamp reads. Two menus cannot be merged into one coherent ranking, so a
 *     session menu REPLACES the workspace menu wholesale. That is the correct
 *     semantics for an ordered list, not an oversight.
 *
 *   - `tierCeilings` is a per-ROLE map, and is merged PER KEY (P-006 of
 *     role-model-one-answer-2026-09-03). It used to be a whole-object replace,
 *     which silently discarded every workspace ceiling the moment a session
 *     override named ONE role: an owner capping `bee` for a session also erased
 *     the standing cap on every other role, raising them instead of lowering
 *     one. Same silent-write class as the main bug this plan exists for — a
 *     correctly-stored setting dropped on the floor with no surface saying so.
 *     A session entry still wins for the roles it names.
 */
export function effectiveTierConfig(
  workspace: { tiers?: readonly ModelTier[]; tierCeilings?: Record<string, string> } | null | undefined,
  session: { modelTiers?: readonly ModelTier[] | null; tierCeilings?: Record<string, string> | null } | null | undefined,
): { tiers?: readonly ModelTier[]; tierCeilings?: Record<string, string> } {
  const sessionTiers = session?.modelTiers && session.modelTiers.length > 0 ? session.modelTiers : undefined;
  const sessionCeilings =
    session?.tierCeilings && Object.keys(session.tierCeilings).length > 0 ? session.tierCeilings : undefined;
  const workspaceCeilings =
    workspace?.tierCeilings && Object.keys(workspace.tierCeilings).length > 0 ? workspace.tierCeilings : undefined;
  return {
    tiers: sessionTiers ?? workspace?.tiers,
    tierCeilings:
      sessionCeilings && workspaceCeilings
        ? { ...workspaceCeilings, ...sessionCeilings }
        : (sessionCeilings ?? workspaceCeilings),
  };
}

/**
 * The tier NAME a role runs at by DEFAULT — the `DEFAULT_MODEL_TIERS` entry whose
 * spec model-id matches the role's committed default (`roleModelDefault`). E.g.
 * queen's default `sonnet` ⇒ the `standard` tier. `undefined` when the role has no
 * committed default or it isn't in the default menu (→ no own-model resolution).
 * Mapped via the DEFAULT menu (names↔committed-specs are stable) so it still
 * resolves after the owner overrides the menu SPECS. Pure.
 */
export function roleHomeTier(role: string): string | undefined {
  const def = roleModelDefault(role);
  if (!def) return undefined;
  const key = specFamilyKey(def);
  return DEFAULT_MODEL_TIERS.find((t) => specFamilyKey(t.spec) === key)?.name;
}

/**
 * Resolve a role's OWN model spec from the effective tier menu — the
 * queen-steering-panel GAP-2 lever: a decider role (queen/operator) does NOT pick
 * its own tier, so the menu only ever governed the tier it picks for OTHERS. This
 * resolves the role's own model so an owner who raises the 👑-tab menu/ceiling
 * actually moves the autonomous role's model.
 *
 * This own-model override is threaded into the tracked autonomous role launcher
 * as `spawnModel`. The invoke route resolves the backend from that model spec,
 * so cross-provider tiers such as `gpt-5.5:high` can move the role onto Codex
 * instead of being applied to the Claude CLI.
 *
 * The role runs at its CEILING tier when one is set (a decider has no self-picker,
 * so its ceiling IS its target — run as strong as the owner allows), else its HOME
 * tier — resolved against the EFFECTIVE (session-override > workspace-default) menu
 * and clamped by `resolveTierSpec` (a too-low ceiling never downgrades below the
 * role floor, EI-7/EI-286). Returns the spec ONLY when it DIFFERS from the role's
 * committed default, so an un-configured / default menu yields `null` = no override
 * = today's behaviour exactly. Pure; caller supplies `effectiveTierConfig`'s output.
 */
export function resolveRoleOwnModelSpec(
  role: string,
  eff: { tiers?: readonly ModelTier[]; tierCeilings?: Record<string, string> },
): string | null {
  const ceiling = roleTierCeiling(eff.tierCeilings, role);
  // No owner/session tier input means the committed role default is already the
  // authority. Re-resolving it through the generic menu can only erase details
  // the role pin deliberately carries (e.g. sonnet-5 `:high`).
  if (!ceiling && !eff.tiers?.length) return null;
  const tier = ceiling || roleHomeTier(role);
  if (!tier) return null;
  const r = resolveTierSpec({ tier, role, tiers: eff.tiers, tierCeilings: eff.tierCeilings });
  if (!r.ok) return null;
  // A requested ceiling below the committed floor is a no-op. Returning the
  // menu row here would replace a stronger/versioned committed default with a
  // weaker alias even though resolveTierSpec correctly reported a floor clamp.
  if (r.clamped === 'floor') return null;
  // Marker-insensitive, EFFORT-sensitive compare: the default menu's specs
  // carry `[1m]` (owner directive 2026-07-02) while committed role defaults
  // are bare, and a marker-only difference is NOT an override — the `[1m]`
  // window rides the exec boundary (`applyRoleModel` normalizeModelSpec) /
  // the psu launcher, so an un-configured menu still yields null = no pin
  // (the docstring invariant). An effort/model difference (opus[1m]:high vs
  // default opus) IS a real override, so plain [1m]-stripping — not
  // specFamilyKey, which also strips effort — is the right key.
  const committed = roleModelDefault(role) ?? '';
  const candidateClass = specModelClass(r.spec);
  const committedClass = specModelClass(committed);
  // Within one known Claude family, an own-model menu row may raise effort but
  // must never weaken the committed role floor or replace its current versioned
  // id with a bare alias. Cross-provider/model-family overrides remain explicit
  // and are returned unchanged.
  if (candidateClass !== 'other' && candidateClass === committedClass) {
    return specEffortRank(r.spec) > specEffortRank(committed) ? r.spec : null;
  }
  const sansMarker = (s: string) => s.replace(/\[1m\]/gi, '').toLowerCase();
  return r.spec && sansMarker(r.spec) !== sansMarker(committed) ? r.spec : null;
}

/**
 * Render the LIVE tier menu as runtime-context lines for a placement
 * decider's launch prompt (queen/operator) — the channel that keeps her
 * rubric in sync with the user's ACTUAL menu (names, specs, and the
 * user-authored per-tier `when` guidance from /settings/agent). Pure;
 * `tierMenuRuntimeLines` below resolves the stored config.
 */
export function tierMenuLines(
  tiers: readonly ModelTier[],
  tierCeilings?: Record<string, string>,
): string[] {
  const menu = tiers.length > 0 ? tiers : DEFAULT_MODEL_TIERS;
  const rows = menu
    .map((t) => `  - ${t.name} (${t.spec})${t.when ? ` — ${t.when}` : ''}`)
    .join('\n');
  const ceilings = Object.entries(tierCeilings ?? {});
  const lines = [
    'MODEL TIERS (weakest → strongest) — pick one per spawn via cup:spawn { tier }; ' +
      'omit for the role default. Your pick is clamped to [role floor, role ceiling], ' +
      'so a wrong tier never downgrades a role — but a too-cheap pick you could have ' +
      'escalated is a silent quality failure; when in doubt, take the stronger.\n' + rows,
  ];
  if (ceilings.length > 0) {
    lines.push(
      `TIER CEILINGS (per role; picks above clamp down): ${ceilings.map(([r, t]) => `${r}≤${t}`).join(', ')}`,
    );
  }
  return lines;
}

/** The stored-config tier menu as runtime-context lines. Best-effort: an
    unreadable config falls back to the committed default menu. */
export async function tierMenuRuntimeLines(): Promise<string[]> {
  try {
    const { readAgentConfig } = await import('../agent-config');
    const cfg = await readAgentConfig();
    return tierMenuLines(cfg.tiers ?? [], cfg.tierCeilings);
  } catch {
    return tierMenuLines([]);
  }
}
