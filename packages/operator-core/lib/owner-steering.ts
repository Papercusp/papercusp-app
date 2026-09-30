/**
 * owner-steering — the owner's per-Hive steering controls for the Queen
 * (queen-steering-panel-2026-06-15, brief B-01; CONTRACT C-1).
 *
 * The owner's "what should the Queen work on, and how" knobs live as
 * `owner-steering:*` keys in the existing `harness_shared.pot_settings` KV (D-001
 * — no migration; Hive-scoped, federates over the Hive peer-log via the capture
 * trigger). This module OWNS the key names + the decoded {@link OwnerSteering}
 * shape (C-1): `pot:set-steering` writes through it, the `hive.steering` sync
 * resolver (B-01) + the Queen wake-brief inject (B-02 `gatherOwnerSteering`) + the
 * survey pause-enforcement (B-02 P-003) read through it. Mirrors `beacon-consent.ts`
 * (the sibling hive_settings-backed owner-policy accessor).
 *
 * Phase 1 keys (focus steering):
 *   owner-steering:directive       — free-text directive surfaced in the wake brief
 *   owner-steering:eligible-plans  — JSON [slug]; empty/absent ⇒ NO restriction
 *   owner-steering:eligible-hives  — JSON [harness-slug]; the placement SCOPE — the
 *                                    hives/harnesses the home Queen may place into
 *                                    (→ scopeFilter.allowedHarnesses, C-2). Empty ⇒
 *                                    NO restriction. (queen-steering-panel B-04 round-2.)
 *   owner-steering:pause-new-work  — bool; pause starting NEW work (HARD in survey)
 *   owner-steering:paused-until    — epoch ms; the pause auto-expires at this time
 *
 * Phase 2 keys (throttle knobs — queen-steering-panel B-08 / P-006, D-005/D-006):
 * each a SESSION override of a live operator seam, surfaced in the wake brief so
 * the Queen self-governs. Precedence everywhere: session override (here) >
 * workspace default (Settings / rate-limit-config) > committed default.
 *   owner-steering:cadence-floor-sec — number; min seconds between Queen wakes
 *                                      (effective floor = MAX(system 60s, this);
 *                                      a FLOOR — the owner can only RAISE it).
 *   owner-steering:max-bees          — int; concurrency ceiling for running agents
 *                                      (effective = MIN(system ceiling, this)).
 *   owner-steering:idle-activities   — { gym?, scout?, dream?, curation?, plan-review? }
 *                                      booleans; each defaults ON, `false`
 *                                      suppresses that idle activity (gym /
 *                                      Scout-ideation / doc+memory curation /
 *                                      Queen review-iteration of Scout drafts).
 *   owner-steering:auto-scale-out    — bool; `false` disables account-pool
 *                                      auto-scale-out (default = enabled).
 *   owner-steering:model-tiers       — SESSION model-tier MENU override (D-006).
 *   owner-steering:tier-ceilings     — SESSION per-role tier CEILINGS override
 *                                      (D-006; e.g. {bee:'opus:xhigh'} pins bees).
 *   owner-steering:create-wake-suppress-plans — string[] of plan slugs (EI-13608).
 *                                      An UNASSIGNED `work_items:create` whose
 *                                      `plan_item.slug` is in this list does NOT
 *                                      fire the Mug's default work_items:create
 *                                      demand-wake — for a KNOWN cup-forbidden
 *                                      plan (e.g. gated on a live 2-machine rig
 *                                      or an owner decision) that re-homes items
 *                                      unassigned and would otherwise burn a
 *                                      no-op survey+decide cycle per create.
 *                                      Empty/absent ⇒ NO suppression (today's
 *                                      behaviour). Does NOT affect eligibility or
 *                                      placement — only whether the CREATE event
 *                                      itself wakes the Mug; a su/owner still
 *                                      claims the item normally.
 *
 * Defaults (a missing/cleared key) reproduce today's pre-steering behaviour, so the
 * feature is purely additive — an un-steered Hive reads `DEFAULT_OWNER_STEERING`.
 */
import type { Sql } from 'postgres';
import { DEFAULT_MODEL_TIERS, type ModelTier } from './agent-config-constants';
import type { FederatedPrimingConfig } from './scout/federated-priming';
import { specModelId } from './fleet/model-tiers';
import { listHiveSettings, setHiveSetting, deleteHiveSetting } from './hive-settings-store';

/** The `hive_settings` keys the steering controls occupy (C-1). */
export const OWNER_STEERING_KEYS = {
  directive: 'owner-steering:directive',
  eligiblePlans: 'owner-steering:eligible-plans',
  eligibleHives: 'owner-steering:eligible-hives',
  // queen-steering decouple 2026-06-30: whether plan-LESS ("loose") frontier work
  // is placed — the "Non-plan work items" toggle. Absent ⇒ TRUE (loose work is
  // placed, today's default); `false` ⇒ the Queen works ONLY plan-tied items.
  includeUnplannedWork: 'owner-steering:include-unplanned-work',
  pauseNewWork: 'owner-steering:pause-new-work',
  pausedUntil: 'owner-steering:paused-until',
  // queen-steering-panel D-006 (model-tier session override): a SESSION-NOW
  // override of the workspace-default model tiers / per-role ceilings for the
  // running fleet — preferred over agent-config at the spawn chokepoint. null /
  // absent ⇒ use the workspace default (no override).
  modelTiers: 'owner-steering:model-tiers',
  tierCeilings: 'owner-steering:tier-ceilings',
  // queen-steering-panel P-006 (throttle knobs, D-005): each wires to a live seam.
  cadenceFloorSec: 'owner-steering:cadence-floor-sec',
  maxBees: 'owner-steering:max-bees',
  idleActivities: 'owner-steering:idle-activities',
  autoScaleOut: 'owner-steering:auto-scale-out',
  // queen-steering-panel P-009 (decomposition-aggressiveness hint): ADVISORY —
  // surfaced in the wake brief, no hard seam (the Queen self-governs decomposition).
  decomposition: 'owner-steering:decomposition',
  // EI-13608: plan slugs whose UNASSIGNED work_items:create should not fire the
  // default demand-wake (a known cup-forbidden plan re-homing items unassigned).
  createWakeSuppressPlans: 'owner-steering:create-wake-suppress-plans',
  federatedPriming: 'owner-steering:federated-priming',
  // model-override-sidebar-2026-06-23: SESSION-NOW per-role MODEL overrides for the
  // FRONT-DOOR agents that launch OUTSIDE the cup:spawn tier path — `sentinel`
  // (the dock psu/Claude TUI) and `overwatch` (the supervisor invoke loop). role →
  // `model[:effort]` spec; absent ⇒ the workspace default (agent-config models.<role>
  // → CLI default). Session-only: lives here in hive_settings (resets with the Hive),
  // NOT the workspace agent-config default.
  modelOverrides: 'owner-steering:model-overrides',
} as const;

/** The idle background activities the owner can gate per-Hive (P-006, D-005). Each
 *  defaults ON; only an explicit `false` suppresses it. `plan-review` gates the
 *  Queen's idle review+iteration of Scout-routed draft plans (the Queen↔Scout
 *  feedback loop, queen-scout-feedback-loop-2026-06-20 D-003 #2 — review never
 *  starves placement). */
export const IDLE_ACTIVITY_KINDS = ['gym', 'scout', 'dream', 'curation', 'plan-review'] as const;
export type IdleActivityKind = (typeof IDLE_ACTIVITY_KINDS)[number];
export type IdleActivityToggles = Partial<Record<IdleActivityKind, boolean>>;

/** Decomposition-aggressiveness hint (P-009): serial ↔ max-parallel lanes. Advisory
 *  — the Queen reads it in her wake brief; there is no hard enforcement seam. */
export const DECOMPOSITION_MODES = ['serial', 'balanced', 'parallel'] as const;
export type DecompositionMode = (typeof DECOMPOSITION_MODES)[number];

/**
 * The decoded owner-steering state — the C-1 payload the `hive.steering` resolver
 * returns and the Queen wake-brief reads. Every field defaults to the
 * no-restriction value, so an un-steered Hive is exactly today's behaviour.
 */
export interface OwnerSteering {
  /** Free-text owner directive surfaced in the wake brief, or null when unset. */
  directive: string | null;
  /** Slugs the Queen may pick up NOW (eligibility, DISTINCT from lifecycle status,
   *  D-002). Empty ⇒ no restriction. */
  eligiblePlans: string[];
  /** The placement SCOPE — hives/harnesses the home Queen may place into (→
   *  scopeFilter.allowedHarnesses, C-2). Empty ⇒ no restriction. (B-04 round-2.) */
  eligibleHives: string[];
  /** Whether plan-LESS ("loose") frontier work-items are placed — the owner's
   *  "Non-plan work items" toggle (queen-steering decouple 2026-06-30). Default
   *  TRUE (loose work placed); false ⇒ the Queen works ONLY plan-tied items.
   *  Independent of eligiblePlans (which scopes plan-tied work). */
  includeUnplannedWork: boolean;
  /** Pause starting NEW work (the Queen drives existing placements to terminal then idles). */
  pauseNewWork: boolean;
  /** Epoch ms the pause auto-expires at, or null. A future value pauses like `pauseNewWork`. */
  pausedUntil: number | null;
  /** SESSION override of the workspace model-tier MENU (weakest→strongest) for the
   *  running fleet (D-006). null ⇒ no override (use the agent-config default). */
  modelTiers?: ModelTier[] | null;
  /** SESSION override of the per-role tier CEILINGS (D-006). null ⇒ no override. */
  tierCeilings?: Record<string, string> | null;
  /** SESSION wake-cadence FLOOR (P-006) — min seconds between Queen wakes. The
   *  effective floor is MAX(system floor, this), so the owner can only RAISE the
   *  interval (slow the loop), never drop below the system minimum. null ⇒ no override. */
  cadenceFloorSec?: number | null;
  /** SESSION concurrency CEILING (P-006) — max concurrently-running agents/bees.
   *  Effective = MIN(system ceiling, this). null ⇒ no override (use the system ceiling). */
  maxBees?: number | null;
  /** SESSION idle-activity gates (P-006) — gym/Scout/curation/plan-review. Each
   *  defaults ON; an explicit `false` suppresses that idle activity. null ⇒ all
   *  default ON. */
  idleActivities?: IdleActivityToggles | null;
  /** SESSION auto-scale-out toggle (P-006) — `false` disables automatic account-pool
   *  scale-out on sustained rate-limit exhaustion. null ⇒ default (enabled). */
  autoScaleOut?: boolean | null;
  /** SESSION decomposition-aggressiveness hint (P-009) — serial ↔ max-parallel lanes.
   *  ADVISORY: surfaced in the wake brief so the Queen self-governs; no hard seam.
   *  null ⇒ default (the Queen's own judgement). */
  decomposition?: DecompositionMode | null;
  /** SESSION per-role MODEL overrides (model-override-sidebar-2026-06-23) for the
   *  front-door agents launched OUTSIDE the cup:spawn tier path — `sentinel` (dock
   *  psu TUI) and `overwatch` (invoke loop). role → `model[:effort]` spec;
   *  absent/empty ⇒ workspace default. null ⇒ no overrides. */
  modelOverrides?: Record<string, string> | null;
  /** SESSION federated Scout priming override — nearby foreign elites plus
   *  crowded/empty niche-map counts. null ⇒ blueprint default. */
  federatedPriming?: Partial<FederatedPrimingConfig> | null;
  /** EI-13608: plan slugs whose UNASSIGNED work_items:create should NOT fire the
   *  default work_items:create demand-wake (a known cup-forbidden plan). Empty ⇒
   *  no suppression (today's behaviour) — every unassigned create wakes the Queen. */
  createWakeSuppressPlans: string[];
}

export const DEFAULT_OWNER_STEERING: OwnerSteering = {
  directive: null,
  eligiblePlans: [],
  eligibleHives: [],
  includeUnplannedWork: true,
  pauseNewWork: false,
  pausedUntil: null,
  modelTiers: null,
  tierCeilings: null,
  cadenceFloorSec: null,
  maxBees: null,
  idleActivities: null,
  autoScaleOut: null,
  decomposition: null,
  modelOverrides: null,
  federatedPriming: null,
  createWakeSuppressPlans: [],
};

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Decode a stored model-tier menu override, dropping malformed entries. null ⇒ no override. */
function asModelTiers(v: unknown): ModelTier[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter(
    (x): x is ModelTier =>
      !!x && typeof x === 'object' && typeof (x as ModelTier).name === 'string' && typeof (x as ModelTier).spec === 'string',
  );
  return out.length > 0 ? out : null;
}

/** Decode a stored per-role ceilings override (role→tier-name). null ⇒ no override. */
function asCeilings(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [role, tier] of Object.entries(v as Record<string, unknown>)) {
    if (typeof tier === 'string' && tier.trim()) out[role] = tier;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Decode a stored per-role model-override map (role→`model[:effort]` spec), dropping
 *  blank specs. null ⇒ no override. (model-override-sidebar-2026-06-23.) */
function asModelOverrides(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [role, spec] of Object.entries(v as Record<string, unknown>)) {
    if (typeof spec === 'string' && spec.trim()) out[role] = spec.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Decode a wake-cadence floor (seconds). A positive finite number, else null —
 *  0/negative round-trips to null (no override) since the effective floor is a MAX. */
function asCadenceFloorSec(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/** Decode a concurrency ceiling — a finite integer ≥ 1, else null (no override).
 *  A 0/negative max would wedge the fleet, so it falls back to "no override". */
function asMaxBees(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n >= 1 ? n : null;
}

/** Decode the idle-activity toggle object — only the known kinds, only booleans.
 *  null when absent/empty (⇒ all default ON). */
function asIdleActivities(v: unknown): IdleActivityToggles | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: IdleActivityToggles = {};
  for (const kind of IDLE_ACTIVITY_KINDS) {
    const val = (v as Record<string, unknown>)[kind];
    if (typeof val === 'boolean') out[kind] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Decode the auto-scale-out toggle — a boolean, else null (⇒ default enabled). */
function asBoolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/** Decode the decomposition hint — one of the known modes, else null (no hint). */
function asDecomposition(v: unknown): DecompositionMode | null {
  return typeof v === 'string' && (DECOMPOSITION_MODES as readonly string[]).includes(v)
    ? (v as DecompositionMode)
    : null;
}

function asFederatedPriming(v: unknown): Partial<FederatedPrimingConfig> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const coerce = (n: unknown): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  const foreignElites = coerce(src.foreignElites);
  const crowded = coerce(src.crowded);
  const empty = coerce(src.empty);
  if (foreignElites == null && crowded == null && empty == null) return null;
  return {
    ...(foreignElites != null ? { foreignElites } : {}),
    ...(crowded != null ? { crowded } : {}),
    ...(empty != null ? { empty } : {}),
  };
}

/**
 * Read the owner-steering state for a Hive in ONE query (listHiveSettings), with
 * every missing key defaulting per {@link DEFAULT_OWNER_STEERING}. Fail-soft by
 * construction — a junk/legacy value for any key falls back to its default rather
 * than throwing into the wake brief / resolver.
 */
export async function getOwnerSteering(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<OwnerSteering> {
  const rows = await listHiveSettings(workspaceId, potHomeSlug, sql);
  const byKey = new Map(rows.map((r) => [r.settingKey, r.value]));
  const directiveVal = byKey.get(OWNER_STEERING_KEYS.directive);
  return {
    directive: typeof directiveVal === 'string' && directiveVal.trim() ? directiveVal : null,
    eligiblePlans: asStringArray(byKey.get(OWNER_STEERING_KEYS.eligiblePlans)),
    eligibleHives: asStringArray(byKey.get(OWNER_STEERING_KEYS.eligibleHives)),
    // Default TRUE — only an explicit stored `false` turns loose work off.
    includeUnplannedWork: byKey.get(OWNER_STEERING_KEYS.includeUnplannedWork) !== false,
    pauseNewWork: byKey.get(OWNER_STEERING_KEYS.pauseNewWork) === true,
    pausedUntil: asFiniteNumber(byKey.get(OWNER_STEERING_KEYS.pausedUntil)),
    modelTiers: asModelTiers(byKey.get(OWNER_STEERING_KEYS.modelTiers)),
    tierCeilings: asCeilings(byKey.get(OWNER_STEERING_KEYS.tierCeilings)),
    cadenceFloorSec: asCadenceFloorSec(byKey.get(OWNER_STEERING_KEYS.cadenceFloorSec)),
    maxBees: asMaxBees(byKey.get(OWNER_STEERING_KEYS.maxBees)),
    idleActivities: asIdleActivities(byKey.get(OWNER_STEERING_KEYS.idleActivities)),
    autoScaleOut: asBoolOrNull(byKey.get(OWNER_STEERING_KEYS.autoScaleOut)),
    decomposition: asDecomposition(byKey.get(OWNER_STEERING_KEYS.decomposition)),
    modelOverrides: asModelOverrides(byKey.get(OWNER_STEERING_KEYS.modelOverrides)),
    federatedPriming: asFederatedPriming(byKey.get(OWNER_STEERING_KEYS.federatedPriming)),
    createWakeSuppressPlans: asStringArray(byKey.get(OWNER_STEERING_KEYS.createWakeSuppressPlans)),
  };
}

/** A partial steering update — omitted fields are left unchanged; `clear` wipes all. */
export interface OwnerSteeringPatch {
  directive?: string | null;
  eligiblePlans?: string[];
  eligibleHives?: string[];
  /** Whether loose (plan-less) work is placed (default true); false ⇒ only plan-tied. */
  includeUnplannedWork?: boolean;
  pauseNewWork?: boolean;
  pausedUntil?: number | null;
  /** Session model-tier menu override (D-006); null / [] clears it. */
  modelTiers?: ModelTier[] | null;
  /** Session per-role tier-ceilings override (D-006); null / {} clears it. */
  tierCeilings?: Record<string, string> | null;
  /** Session wake-cadence floor in seconds (P-006); null / 0 clears it. */
  cadenceFloorSec?: number | null;
  /** Session concurrency ceiling (P-006); null / <1 clears it. */
  maxBees?: number | null;
  /** Session idle-activity toggles (P-006); null / {} clears it (⇒ all default ON). */
  idleActivities?: IdleActivityToggles | null;
  /** Session auto-scale-out toggle (P-006); null clears it (⇒ default enabled). */
  autoScaleOut?: boolean | null;
  /** Session decomposition hint (P-009); null clears it. */
  decomposition?: DecompositionMode | null;
  /** Session per-role model overrides (model-override-sidebar-2026-06-23); null / {}
   *  clears them. Merge-semantics are the caller's job: pass the full desired map. */
  modelOverrides?: Record<string, string> | null;
  /** Session federated Scout priming override; null / {} clears it. */
  federatedPriming?: Partial<FederatedPrimingConfig> | null;
  /** EI-13608: plan slugs to suppress the work_items:create demand-wake for;
   *  [] clears it (⇒ no suppression). */
  createWakeSuppressPlans?: string[];
  /** Wipe ALL steering keys back to {@link DEFAULT_OWNER_STEERING}. */
  clear?: boolean;
}

/**
 * Write an owner-steering patch (upsert per field). `clear:true` deletes EVERY
 * steering key (back to the default no-restriction state); otherwise only the
 * provided fields are written (a normalized null/empty CLEARS that field; an
 * omitted field is untouched). Returns the resulting full state. The values
 * federate over the Hive peer-log via the hive_settings capture trigger.
 */
export async function setOwnerSteering(
  workspaceId: string,
  potHomeSlug: string,
  patch: OwnerSteeringPatch,
  sql?: Sql,
): Promise<OwnerSteering> {
  if (patch.clear) {
    for (const key of Object.values(OWNER_STEERING_KEYS)) {
      await deleteHiveSetting(workspaceId, potHomeSlug, key, sql);
    }
    return DEFAULT_OWNER_STEERING;
  }
  const writes: Array<[string, unknown]> = [];
  if (patch.directive !== undefined) {
    writes.push([OWNER_STEERING_KEYS.directive, patch.directive && patch.directive.trim() ? patch.directive : null]);
  }
  if (patch.eligiblePlans !== undefined) {
    writes.push([OWNER_STEERING_KEYS.eligiblePlans, asStringArray(patch.eligiblePlans)]);
  }
  if (patch.eligibleHives !== undefined) {
    writes.push([OWNER_STEERING_KEYS.eligibleHives, asStringArray(patch.eligibleHives)]);
  }
  if (patch.includeUnplannedWork !== undefined) {
    writes.push([OWNER_STEERING_KEYS.includeUnplannedWork, patch.includeUnplannedWork === true]);
  }
  if (patch.modelTiers !== undefined) {
    writes.push([OWNER_STEERING_KEYS.modelTiers, asModelTiers(patch.modelTiers)]);
  }
  if (patch.tierCeilings !== undefined) {
    writes.push([OWNER_STEERING_KEYS.tierCeilings, asCeilings(patch.tierCeilings)]);
  }
  if (patch.cadenceFloorSec !== undefined) {
    writes.push([OWNER_STEERING_KEYS.cadenceFloorSec, asCadenceFloorSec(patch.cadenceFloorSec)]);
  }
  if (patch.maxBees !== undefined) {
    writes.push([OWNER_STEERING_KEYS.maxBees, asMaxBees(patch.maxBees)]);
  }
  if (patch.idleActivities !== undefined) {
    writes.push([OWNER_STEERING_KEYS.idleActivities, asIdleActivities(patch.idleActivities)]);
  }
  if (patch.autoScaleOut !== undefined) {
    writes.push([OWNER_STEERING_KEYS.autoScaleOut, asBoolOrNull(patch.autoScaleOut)]);
  }
  if (patch.decomposition !== undefined) {
    writes.push([OWNER_STEERING_KEYS.decomposition, asDecomposition(patch.decomposition)]);
  }
  if (patch.modelOverrides !== undefined) {
    writes.push([OWNER_STEERING_KEYS.modelOverrides, asModelOverrides(patch.modelOverrides)]);
  }
  if (patch.federatedPriming !== undefined) {
    writes.push([OWNER_STEERING_KEYS.federatedPriming, asFederatedPriming(patch.federatedPriming)]);
  }
  if (patch.createWakeSuppressPlans !== undefined) {
    writes.push([OWNER_STEERING_KEYS.createWakeSuppressPlans, asStringArray(patch.createWakeSuppressPlans)]);
  }
  // EI-8277 root cause: a bare pause write (`pot:set-steering { pauseNewWork:true }`,
  // e.g. from the operator palette/Queen tab) used to preserve a prior directive
  // that said "gate lifted; resume normal placement". The structured gate was
  // intentionally paused, but every later read looked like drift because the
  // stale free-text directive still said resume. Keep omitted fields untouched
  // in general, but do not preserve a resume-sounding directive across an
  // explicit pause unless the caller also supplied a directive in the same patch.
  const enablingPause =
    patch.pauseNewWork === true ||
    (patch.pausedUntil !== undefined && asFiniteNumber(patch.pausedUntil) != null);
  if (enablingPause && patch.directive === undefined) {
    const current = await getOwnerSteering(workspaceId, potHomeSlug, sql);
    if (directiveSuggestsResume(current.directive)) {
      writes.push([OWNER_STEERING_KEYS.directive, null]);
    }
  }
  if (patch.pauseNewWork !== undefined) {
    writes.push([OWNER_STEERING_KEYS.pauseNewWork, patch.pauseNewWork === true]);
  }
  if (patch.pausedUntil !== undefined) {
    writes.push([OWNER_STEERING_KEYS.pausedUntil, asFiniteNumber(patch.pausedUntil)]);
  }
  for (const [settingKey, value] of writes) {
    await setHiveSetting({ workspaceId, potHomeSlug, settingKey, value }, sql);
  }
  return getOwnerSteering(workspaceId, potHomeSlug, sql);
}

/**
 * True when starting NEW work is paused right now — an explicit `pauseNewWork` OR
 * an un-expired `pausedUntil`. The single predicate the survey pause-enforcement
 * (B-02 P-003) and the wake brief share, so "paused" means the same everywhere.
 */
export function isPausedNow(s: OwnerSteering, nowMs: number): boolean {
  if (s.pauseNewWork) return true;
  return s.pausedUntil != null && nowMs < s.pausedUntil;
}

// ─── Directive/pause consistency nudge (EI-8277) ────────────────────────────
// `directive` (free text) and `pauseNewWork` (the hard gate) are deliberately
// INDEPENDENT fields (C-1) — a caller may legitimately update one without the
// other. But that independence lets them drift silently: an owner (or an agent
// writing on the owner's behalf) can edit the directive text to say "resume" /
// "hold lifted" while never actually flipping `pauseNewWork` back to false, and
// nothing previously caught it — the Mug had to notice the contradiction by eye,
// every wake, and it recurred after being fixed once (EI-8277). This is advisory
// ONLY: it never auto-clears the pause (only the owner / an explicit
// pot:set-steering write should do that) — it just makes the drift visible
// wherever steering is read, instead of requiring a human/Mug to notice it.

/** Loose keyword match for directive text that reads like "the pause is over" —
 *  a heuristic (false positives just add a harmless nudge to double-check; false
 *  negatives just mean no nudge). Kept intentionally simple/lexical rather than
 *  an LLM call — this only gates a wake-brief nudge, not an autonomous action. */
const RESUME_LANGUAGE =
  /\b(resum(?:e|ing|ed)|(?:hold|pause|gate)\b.{0,20}\b(?:lifted|released|cleared|over)|un-?paus(?:e|ed|ing)|no longer paused|back to (?:normal|autonomous)|go[\s-]?ahead)\b/i;

/** EI-13023: directive text that COMMANDS active placement/work without using any
 *  explicit pause-lifecycle word ("resume"/"lifted"/…). The live incident: the
 *  standing directive "Run the full Mug→Cup→Kettle→Blender loop. Place and
 *  complete real work" sailed past RESUME_LANGUAGE, so `pauseNewWork: true`
 *  silently froze ALL placements for ~36h with `inconsistent: false`. A directive
 *  that orders the loop to run contradicts a hard pause exactly as much as one
 *  that says "resume" — flag both. Same suppression rules as RESUME_LANGUAGE
 *  (ACTIVE_PAUSE_LANGUAGE wins, so EI-9952-class quoted/superseded work text in a
 *  genuine pause directive stays consistent). Deliberately targeted alternations
 *  rather than loose fillers, so prose like "run the numbers on the loop metrics"
 *  does not trip it. */
const WORK_COMMAND_LANGUAGE =
  /\b(?:run(?:ning)? the (?:full )?(?:auto[- ]?loop|loop\b|\S{0,24}(?:→|->)\S{0,40}\s*loop)|(?:place|placing) (?:and \w+ )?(?:real |new )?work\b|keep placing|start placing|(?:place|placing) from the frontier|work the frontier)/i;

/** Directive text that explicitly asserts the pause is STILL in effect. When any
 *  of these is present, resume-words elsewhere in the same directive are almost
 *  certainly NEGATED ("do not resume"), QUOTED/SUPERSEDED ("'resume ...' is
 *  SUPERSEDED"), or CONDITIONAL ("in force until lifted") — i.e. describing the
 *  pause's lifecycle, not asking to resume now. A directive that genuinely lifts
 *  the pause won't also carry these (they'd contradict its own message), so this
 *  guard suppresses the false-positive drift nudge without hiding real drift.
 *  EI-9952: an unambiguous token-conservation pause ("in force until lifted;
 *  pause new work ... do not resume") was flagged inconsistent purely because it
 *  mentioned "resume" in negated/superseded contexts. */
const ACTIVE_PAUSE_LANGUAGE =
  /\b(?:until (?:it (?:is|'s) )?lifted|until further notice|in force until|pause new work|no new (?:work|placements|placement)|do ?n(?:o|')t (?:resume|schedule)|still (?:paused|in force)|remains? (?:paused|in force)|keep(?:ing)? (?:the )?pause)\b/i;

/** Does this directive's free text read like the owner wants new work resumed?
 *  An explicit active-pause assertion (ACTIVE_PAUSE_LANGUAGE) overrides any
 *  resume-word match — see that heuristic for why (EI-9952). */
export function directiveSuggestsResume(directive: string | null): boolean {
  if (!directive) return false;
  if (ACTIVE_PAUSE_LANGUAGE.test(directive)) return false;
  return RESUME_LANGUAGE.test(directive) || WORK_COMMAND_LANGUAGE.test(directive);
}

/** True when the stored steering looks INTERNALLY inconsistent: the directive
 *  text reads like the pause was lifted, but `pauseNewWork` is still the hard
 *  gate ON. Callers (the wake brief, `pot:get-steering`, the 👑 tab) surface this
 *  as a reconcile-nudge — see the section banner above for why it's advisory-only. */
export function steeringLooksInconsistent(s: OwnerSteering): boolean {
  return s.pauseNewWork === true && directiveSuggestsResume(s.directive);
}

// ─── Model-spec drift nudge (EI-12807) ──────────────────────────────────────
// A pot-level `modelTiers` / `modelOverrides` SESSION override always wins over
// the workspace default (by design). So a GLOBAL tier-menu fix (config:tiers-set)
// that replaces a broken/renamed model spec CANNOT reach a pot that pins the old
// spec through its own steering — the stale pin silently survives the fix, and
// every cup/kettle spawn on that pot dies on "selected model unavailable". The
// EI-12807 incident: after the workspace menu was fixed to drop the dead
// "claude-sonnet-5[1m]:high", the papercusp pot's own steering kept pinning it
// for ~4h while every escalation blamed the launcher/orchestrator for not
// reloading — nobody checked pot-level steering, because nothing surfaced it.
// This is advisory ONLY (like the EI-8277 nudge above): it never rewrites the
// override — it just makes the drift VISIBLE wherever steering is read
// (pot:get-steering + the Mug wake brief) so a Mug/owner reconciles it on the
// very next read instead of chasing a launcher-restart red herring.

/** The MODEL-ID comparison key for drift detection: the spec's model id with the
 *  `[1m]` window marker and any `:effort` suffix stripped, lowercased. Deliberately
 *  STRICTER than `specFamilyKey` (which collapses the dead `claude-sonnet-5` and a
 *  live `sonnet` into ONE family) — the whole trap in EI-12807 is that a drifted
 *  spec looks family-identical to a valid one, so the drift is invisible at family
 *  granularity. Window/effort differences are NOT drift (they don't change which
 *  model launches), so they're normalized away. */
function modelIdKey(spec: string): string {
  return specModelId(spec).replace(/\[1m\]/gi, '').trim().toLowerCase();
}

/** Every distinct model spec a steering override PINS — the union of its
 *  `modelTiers[].spec` and `modelOverrides` values. The set the drift detector
 *  checks against the committed tier menu. Pure. */
export function steeringPinnedModelSpecs(s: OwnerSteering): string[] {
  const specs = new Set<string>();
  for (const t of s.modelTiers ?? []) {
    const spec = t?.spec?.trim();
    if (spec) specs.add(spec);
  }
  for (const spec of Object.values(s.modelOverrides ?? {})) {
    if (typeof spec === 'string' && spec.trim()) specs.add(spec.trim());
  }
  return [...specs];
}

/**
 * Detect steering model-spec DRIFT (EI-12807) — see the section banner above.
 * Returns each PINNED spec (from `modelTiers` / `modelOverrides`) whose model id
 * matches NO entry in the CURRENT committed tier menu (`committedTiers`, i.e. the
 * workspace-default menu; an empty menu falls back to `DEFAULT_MODEL_TIERS`).
 * Compared at model-id granularity via {@link modelIdKey}, so it flags the dead
 * `claude-sonnet-5[1m]:high` against a menu that now runs `sonnet[1m]` — where a
 * family-level compare would miss it. An empty override, or a menu that still
 * carries the pinned ids, yields `[]` (no drift). Advisory only; never rewrites
 * the override. Pure.
 */
export function steeringModelSpecDrift(
  s: OwnerSteering,
  committedTiers: readonly ModelTier[],
): string[] {
  const pinned = steeringPinnedModelSpecs(s);
  if (pinned.length === 0) return [];
  const menu = committedTiers.length > 0 ? committedTiers : DEFAULT_MODEL_TIERS;
  const knownIds = new Set(menu.map((t) => modelIdKey(t.spec)));
  return pinned.filter((spec) => !knownIds.has(modelIdKey(spec)));
}

// ─── Throttle-knob accessors (P-006) ────────────────────────────────────────
// Shared so every live seam + the wake-brief + the tests apply the SAME
// resolution. Each is pure; all default to "no override" (today's behaviour).

/** The effective wake-cadence floor in seconds: MAX(system floor, owner override).
 *  A floor — the owner can only RAISE the min interval, never drop below `systemFloorSec`. */
export function effectiveCadenceFloorSec(s: OwnerSteering, systemFloorSec: number): number {
  return Math.max(systemFloorSec, s.cadenceFloorSec ?? 0);
}

/** The effective concurrency ceiling: MIN(system ceiling, owner override). No
 *  override ⇒ the system ceiling unchanged. Never returns below 1 when an owner
 *  cap is set (the decoder already clamps maxBees ≥ 1). */
export function effectiveMaxBees(s: OwnerSteering, systemCeiling: number): number {
  return s.maxBees != null ? Math.min(systemCeiling, s.maxBees) : systemCeiling;
}

/** Dream spend requires explicit opt-in. Other idle activities retain their default-ON policy. */
export function idleActivityEnabled(s: OwnerSteering, kind: IdleActivityKind): boolean {
  const t = s.idleActivities;
  if (kind === 'dream') return t?.dream === true;
  return !t || t[kind] !== false;
}

/** Whether automatic account-pool scale-out is enabled. Default ON — only an
 *  explicit `false` disables it (manual `accounts:scale_out` still works). */
export function isAutoScaleOutEnabled(s: OwnerSteering): boolean {
  return s.autoScaleOut !== false;
}

/**
 * Resolve whether an idle background activity (gym / Scout / curation) may run for a
 * workspace's home hive — the single gate the idle-activity seams call (P-006, D-005).
 * Resolves the home hive (the slug the owner steers on the 👑 tab) unless one is
 * passed, then checks the toggle. Dream fails closed without scope/settings;
 * other activities retain their fail-soft ON policy. Async + a dynamic import of resolvePotHomeSlug so this leaf
 * module keeps no static edge to the hive layer.
 */
export async function idleActivityAllowed(
  workspaceId: string,
  kind: IdleActivityKind,
  potHomeSlug?: string,
  sql?: Sql,
): Promise<boolean> {
  try {
    let home = potHomeSlug?.trim() || null;
    if (!home) {
      const { resolvePotHomeSlug } = await import('./pot/wake');
      home = resolvePotHomeSlug();
    }
    if (!home) return kind !== 'dream';
    const s = await getOwnerSteering(workspaceId, home, sql);
    return idleActivityEnabled(s, kind);
  } catch {
    return kind !== 'dream';
  }
}

/** True when ANY throttle knob is set away from its default — drives whether the
 *  wake brief renders a throttle section (P-006) and the resolver/UI "overriding"
 *  badge. Model-tier overrides count (they're surfaced as a throttle knob too). */
export function hasActiveThrottle(s: OwnerSteering): boolean {
  return (
    s.cadenceFloorSec != null ||
    s.maxBees != null ||
    s.autoScaleOut === false ||
    s.decomposition != null ||
    (!!s.idleActivities && IDLE_ACTIVITY_KINDS.some((k) => s.idleActivities?.[k] === false)) ||
    (!!s.modelTiers && s.modelTiers.length > 0) ||
    (!!s.tierCeilings && Object.keys(s.tierCeilings).length > 0)
  );
}
