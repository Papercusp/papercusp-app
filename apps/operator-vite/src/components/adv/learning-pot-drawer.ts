/**
 * The per-pot learning drawer's model (learning-pot-scope-gate-2026-08-30, P-012).
 *
 * WHAT THIS SURFACE IS. The rail's popover (P-007) is a quick arm/disarm panel
 * hanging off a chip. This is the FULL per-pot control surface: the master
 * switch, then every lane the pot owns as a real field — armed state, budget
 * WITH ITS UNIT, who enforces it, what it has spent. D-005 routed a dormant
 * pot's controls through the picker; D-008 then measured that the picker
 * restores the GATE ONLY, so a switched-off pot's per-lane switches had nowhere
 * to live but the rail chip. That is why the rail cannot collapse (P-052) and
 * why this model exists.
 *
 * ⚠ THE CONSTRAINT THAT MADE THIS ITEM LOAD-BEARING. This drawer must be
 * reachable for a pot that has NO rail chip — i.e. from the every-pot picker.
 * `buildPotDrawer` therefore takes a pot SLUG and the raw arming, never a
 * `LearningPotChip`: depending on a chip would rebuild the exact dependency
 * D-008 recorded and leave P-052 blocked forever.
 *
 * THE SECTION MAP IS LOOP-ID FAMILIES, NOT ENGINES (D-009). P-012's text names
 * "Scout / Gym / Frontier / Blender", which reads as four independent engines.
 * Two of those readings are false and both were measured:
 *
 *   - `blender:` IS the scout registrant grain. `scoutLoopId(slug)` returns
 *     `blender:<slug>` and `SCOUT_LOOP_ID_PREFIX = 'blender:'`
 *     (learning-governor/core.ts:196-206), so a pot's scout cycle is armed and
 *     budgeted by its `blender:<pot>` row. The Scout section here is the
 *     WORKSPACE CEILING — a different layer, summed across every `blender:`
 *     registrant over 24h — and it says so, in both directions, rather than
 *     letting someone hunt for a per-pot scout switch that does not exist.
 *   - Four names do not cover the data. Measured over the live workspace,
 *     17 non-gym lanes: 6 `dream:`, 2 `frontier:`, 1 `blender:`, and EIGHT with
 *     no prefix at all. Four sections would drop 14 of 17 — and for 6 of the 28
 *     pots would drop every lane they have, rendering an empty drawer for a pot
 *     that is armed and spending. So there is a fifth section, and it is a
 *     PARTITION (like `partitionLearningPotRail`), never a filter.
 *
 * A BUDGET IS NEVER A BARE NUMBER. `budgetKind` is the UNIT, and it decides
 * whether "remaining" exists at all: `remainingLoopBudgetUsd` returns a
 * per-cycle budget UNCHANGED rather than `budget − spent` (core.ts:90-95),
 * because a per-cycle cap bounds ONE run while `spentUsd` accumulates forever.
 * Live proof this is not pedantry: `blender:papercusp` is a $5 per-cycle cap
 * carrying $513.82 of cumulative spend — subtracting would print
 * "−$508.82 remaining" for a lane that is perfectly healthy.
 *
 * NULLISH DISCIPLINE (D-006). Every field below is declared required and every
 * one crosses a sync CACHE boundary, where the type describes the current
 * server and not the bytes this client holds. Iterating `undefined` throws as
 * hard as a bad dereference, and that crash took out the whole Learning tab
 * once already (WI-1397883).
 */
import type {
  AutomationArming,
  AutomationGymArm,
  AutomationLaneArm,
  AutomationScoutCeiling,
} from '@papercusp/operator-core/lib/automation/catalog';

import {
  DEFAULT_SCOUT_BUDGET,
  type ScoutBudget,
} from '@papercusp/operator-core/lib/scout/budget';

import { potArmingDetail, potMasterSwitch, type PotSegmentState } from './learning-pot-rail';

/**
 * Derived from the catalog type rather than re-declared, so a new budget kind
 * on the server is a compile error here instead of a silently unhandled unit.
 */
export type PotDrawerBudgetKind = AutomationLaneArm['budgetKind'];

export const POT_DRAWER_SECTION_IDS = ['scout', 'gym', 'frontier', 'blender', 'other'] as const;
export type PotDrawerSectionId = (typeof POT_DRAWER_SECTION_IDS)[number];

/**
 * Loop-id prefixes that own a NAMED section. Order matters only for
 * determinism; the prefixes are disjoint by construction (core.ts mints them).
 * Everything not listed here lands in `other` — see the module header for why
 * that is the majority case rather than a leftover bin.
 */
const NAMED_LANE_PREFIXES: ReadonlyArray<readonly [string, PotDrawerSectionId]> = [
  ['frontier:', 'frontier'],
  ['blender:', 'blender'],
];

/** Which section a lane belongs to. Total by construction: never returns undefined. */
export function laneSectionId(loopId: string): PotDrawerSectionId {
  for (const [prefix, id] of NAMED_LANE_PREFIXES) {
    if (loopId.startsWith(prefix)) return id;
  }
  return 'other';
}

export interface PotDrawerBudget {
  /** null = no budget set. For a governed lane that means the governor REFUSES it. */
  usd: number | null;
  /** null when the row has no budget kind of its own (the workspace ceiling). */
  kind: PotDrawerBudgetKind | null;
  /** The unit, spelled out. A bare number is never rendered by this surface. */
  unit: string;
  /** null = not attributable from this read. Never coerced to 0. */
  spentUsd: number | null;
  /** ONLY for 'lifetime' budgets — see the module header. */
  remainingUsd: number | null;
  /** Why `remainingUsd` is absent, when it is. null when it is present. */
  remainingNote: string | null;
}

/** The write that changes one field, named by the tool it actually calls. */
export type PotDrawerWrite =
  | { tool: 'gym:arm'; harness: string }
  | { tool: 'governor:arm'; loopId: string }
  | { tool: 'hive.overrideSet'; potSlug: string; section: 'budget'; field: PotDrawerBudgetKey };

/**
 * THE POT'S SCOUT-CYCLE BUDGET (P-013 / D-011) — the CONFIG, not the mirror.
 *
 * Keyed off `ScoutBudget` itself rather than re-listed, so a new key on the
 * server is a COMPILE ERROR here instead of a knob that silently stops being
 * editable — the same discipline `PotDrawerBudgetKind` follows above.
 *
 * These are deliberately NOT `PotDrawerBudget`: only `maxCostUsd` is money.
 * The other two are fan-out COUNTS, and forcing them through `budgetUnit()`
 * would print "USD per cycle" next to a number of critics.
 */
export type PotDrawerBudgetKey = keyof Required<ScoutBudget>;

interface BudgetKeySpec {
  label: string;
  /** Spelled out, and not all of these are USD. */
  unit: string;
  /** Whole numbers only? (`resolveScoutBudget` floors the two counts.) */
  integer: boolean;
  /**
   * The smallest value the ENGINE will honour. 0 is a real cost cap — "no LLM
   * spend this cycle" (budget.ts EI-305) — but `resolveScoutBudget` runs the two
   * counts through `pos()`, so a 0 there is discarded and the default returns.
   * Encoding that here stops the UI from offering a value the engine ignores.
   */
  min: number;
}

const BUDGET_KEY_SPEC: Record<PotDrawerBudgetKey, BudgetKeySpec> = {
  maxCostUsd: { label: 'Cost cap', unit: 'USD per cycle', integer: false, min: 0 },
  maxIdeators: { label: 'Ideators', unit: 'ideators per cycle', integer: true, min: 1 },
  maxCriticsPerIdea: { label: 'Critics per idea', unit: 'critics per idea', integer: true, min: 1 },
};

/** Stable render order, derived from the spec so it cannot fall out of sync with it. */
export const POT_DRAWER_BUDGET_KEYS = Object.keys(BUDGET_KEY_SPEC) as PotDrawerBudgetKey[];

export interface PotDrawerConfigField {
  /** Stable id for the write, the React key, and the test hook. */
  key: string;
  field: PotDrawerBudgetKey;
  label: string;
  unit: string;
  integer: boolean;
  min: number;
  /** null = UNSET, which means the engine default applies. Never coerced to 0. */
  value: number | null;
  /** What runs when `value` is null. Read off DEFAULT_SCOUT_BUDGET, never retyped. */
  engineDefault: number;
  /** The number the engine will actually use right now. */
  effective: number;
  /** Said out loud, because an empty box reads as "zero" to everyone who did not write it. */
  note: string;
  write: PotDrawerWrite;
}

export interface PotDrawerField {
  /** Stable id for the write, the React key, and the test hook. */
  key: string;
  label: string;
  /** The exact slug / loopId the write is keyed by, so a row can be matched to its DB row. */
  ref: string | null;
  /** null = there is nothing armable at this row (the workspace ceiling). */
  armed: boolean | null;
  /** The raw enforcement token from the row. */
  enforcement: string;
  /** What that token MEANS, in words — the pane states it rather than implying it. */
  enforcementNote: string;
  budget: PotDrawerBudget;
  /** null ⇒ not writable from this surface; `readOnlyReason` then says why. */
  write: PotDrawerWrite | null;
  readOnlyReason: string | null;
  /** Free-text row status (the gym's `status`, a ceiling read failure). */
  status: string | null;
}

export interface PotDrawerSection {
  id: PotDrawerSectionId;
  title: string;
  /** One line: what this section is, and where its control lives if not here. */
  note: string;
  fields: PotDrawerField[];
  /**
   * Editable CONFIG knobs for this section (P-013). Distinct from `fields`,
   * which are governor/gym ROWS: these write the pot's settings config, which
   * is the source the governor rows are rebuilt from.
   */
  configFields: PotDrawerConfigField[];
  /**
   * True when this pot has no rows here. Rendered as a STATED absence, never
   * hidden. A section carrying only `configFields` is NOT empty — the scout
   * budget is editable for a pot that has never registered a lane.
   */
  empty: boolean;
}

export interface PotDrawerModel {
  potSlug: string;
  /** The per-pot master switch. 'unknown' when the scope read failed (D-006 rule 2). */
  learning: PotSegmentState;
  /** Always all five ids, in `POT_DRAWER_SECTION_IDS` order — absence is stated, not omitted. */
  sections: PotDrawerSection[];
  /** Governor lanes this pot owns. */
  laneCount: number;
  /**
   * Lanes actually placed in a section. Equal to `laneCount` by construction —
   * exported so the partition property is ASSERTABLE rather than assumed, which
   * is what stops a future `.filter()` from silently hiding a spending lane.
   */
  placedLaneCount: number;
}

function money(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function budgetUnit(kind: PotDrawerBudgetKind | null): string {
  if (kind === 'per-cycle') return 'USD per cycle';
  if (kind === 'lifetime') return 'USD lifetime';
  return 'USD';
}

/**
 * Budget + remaining for one governed row.
 *
 * The whole point is the `per-cycle` branch: `remainingLoopBudgetUsd` reports a
 * per-cycle row's cap UNCHANGED, so subtracting spend here would render a
 * healthy per-run cap as a lifetime overrun. This returns null and SAYS WHY
 * instead, because a blank cell reads as "we didn't bother", which invites the
 * next person to helpfully fill it in with the subtraction.
 */
export function drawerBudget(
  budgetUsd: number | null | undefined,
  kind: PotDrawerBudgetKind | null,
  spentUsd: number | null | undefined,
): PotDrawerBudget {
  const usd = money(budgetUsd);
  const spent = money(spentUsd);
  const lifetime = kind === 'lifetime';
  return {
    usd,
    kind,
    unit: budgetUnit(kind),
    spentUsd: spent,
    remainingUsd: lifetime && usd !== null ? usd - (spent ?? 0) : null,
    remainingNote:
      lifetime && usd !== null
        ? null
        : kind === 'per-cycle'
          ? 'A per-cycle cap bounds one run; spend accumulates past it, so there is no remaining balance'
          : 'No budget set — the governor refuses unattended spend until one is',
  };
}

/**
 * The pot's scout-cycle budget, read from its settings config (P-013 / D-011).
 *
 * `config` arrives from the `hive.overrides` sync query as `unknown` — it is a
 * user-authored JSON delta, so every key is validated here rather than trusted.
 * A missing or non-finite key is UNSET (null), never 0: `maxCostUsd: 0` is a
 * real instruction ("no LLM spend this cycle"), so collapsing the two would
 * silently switch a pot's scout off and call it a default.
 */
export function drawerScoutBudget(
  potSlug: string,
  config: unknown,
): PotDrawerConfigField[] {
  const delta =
    config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};

  return POT_DRAWER_BUDGET_KEYS.map<PotDrawerConfigField>((field) => {
    const spec = BUDGET_KEY_SPEC[field];
    const engineDefault = DEFAULT_SCOUT_BUDGET[field];
    const raw = delta[field];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    return {
      key: `budget/${field}`,
      field,
      label: spec.label,
      unit: spec.unit,
      integer: spec.integer,
      min: spec.min,
      value,
      engineDefault,
      effective: value ?? engineDefault,
      note:
        value === null
          ? `Unset — the engine default of ${engineDefault} ${spec.unit} applies.`
          : `Overrides the engine default of ${engineDefault} ${spec.unit}.`,
      write: { tool: 'hive.overrideSet', potSlug, section: 'budget', field },
    };
  });
}

function enforcementNote(enforcement: string): string {
  if (enforcement === 'native') {
    return "Native — the lane's own gate decides; the governor row mirrors it";
  }
  if (enforcement === 'governor') {
    return 'Governor — the learning-governor preflight gates every run';
  }
  return `Enforced by ${enforcement}`;
}

/**
 * The Scout section: the WORKSPACE ceiling, deliberately read-only here.
 *
 * `learning:set-scout-budget` writes one number for the whole workspace. Putting
 * that write on a PER-POT drawer would be a control that silently changes every
 * other pot — the same failure D-005/P-007 refused when it gave Scout no
 * per-pot switch. So the row states the value with its unit and names where the
 * per-pot control actually is (the `blender:` lane below).
 */
function scoutField(ceiling: AutomationScoutCeiling | null | undefined): PotDrawerField {
  const effective = money(ceiling?.effectiveUsd);
  return {
    key: 'scout-ceiling',
    label: 'Workspace scout ceiling',
    ref: null,
    armed: null,
    enforcement: 'native',
    enforcementNote:
      'Native — scout has no preflight; the ceiling is checked against 24h of ledgered spend',
    budget: {
      usd: effective,
      kind: null,
      unit: 'USD per 24h, workspace-wide',
      spentUsd: null,
      remainingUsd: null,
      remainingNote:
        'Measured across every pot in the workspace over a rolling 24h window, not against this pot',
    },
    write: null,
    readOnlyReason:
      "Scout is armed workspace-wide, so a switch here would change every pot. Set it with learning:set-scout-budget; this pot's own scout cycle is the blender: lane below.",
    status: ceiling == null ? 'Ceiling unreadable' : null,
  };
}

/** The Gym section's one field. Gym is `native`/`lifetime` per `gymRegistrationInput`. */
function gymField(potSlug: string, gym: AutomationGymArm): PotDrawerField {
  return {
    key: 'gym',
    label: 'Gym autoloop',
    ref: potSlug,
    armed: gym.enabled === true,
    enforcement: 'native',
    enforcementNote:
      "Native — the autoloop tick's own eligibility check IS the gate; the gym: governor row mirrors it",
    budget: drawerBudget(gym.budgetUsd, 'lifetime', gym.spentUsd),
    write: { tool: 'gym:arm', harness: potSlug },
    readOnlyReason: null,
    status: gym.status ?? null,
  };
}

function laneField(lane: AutomationLaneArm): PotDrawerField {
  const enforcement = lane.enforcement ?? 'governor';
  return {
    key: `lane/${lane.loopId}`,
    label: lane.displayName || lane.loopId,
    ref: lane.loopId,
    armed: lane.enabled === true,
    enforcement,
    enforcementNote: enforcementNote(enforcement),
    // budgetKind is read off the row, never inferred from the section: a
    // per-cycle row in the Frontier section is a real possibility and the unit
    // must follow the ROW, not the heading it happens to sit under.
    budget: drawerBudget(lane.budgetUsd, lane.budgetKind ?? 'lifetime', lane.spentUsd),
    // P-013 / D-011: a `blender:` row is a MIRROR, not a control. The scout tick
    // re-registers it after every cycle with `budgetUsd` AND `enabled` taken from
    // the pot's budget CONFIG (scout-cycle-action.ts:121-136 -> run.ts:301,368 ->
    // scoutRegistrationInput -> an upsert that sets both from EXCLUDED, while
    // deliberately omitting spent_usd so THAT survives). So a `governor:arm` here
    // is reverted on the next tick. Offering it would be a control that lies —
    // the same reason D-009 made the Scout ceiling read-only on this surface.
    ...(isBlenderLane(lane.loopId)
      ? {
          write: null,
          readOnlyReason:
            'The scout cadence rewrites this row from the pot’s budget config after every cycle, so an edit here would not survive the next tick. The Scout cycle budget fields in this section are the real control.',
        }
      : { write: { tool: 'governor:arm' as const, loopId: lane.loopId }, readOnlyReason: null }),
    status: null,
  };
}

/** A `blender:` lane is the scout-cadence registrant — see `laneField` and D-011. */
function isBlenderLane(loopId: string): boolean {
  return laneSectionId(loopId) === 'blender';
}

const SECTION_TITLE: Record<PotDrawerSectionId, string> = {
  scout: 'Scout',
  gym: 'Gym',
  frontier: 'Frontier',
  blender: 'Blender',
  other: 'Other lanes',
};

const SECTION_NOTE: Record<PotDrawerSectionId, string> = {
  scout:
    'Gated per-pot by the switch above, but armed and budgeted workspace-wide — so the number below is the ceiling for every pot, not this one.',
  gym: 'This pot’s gym autoloop. Its budget accumulates over the lane’s lifetime.',
  frontier: 'Frontier lanes (loop ids beginning frontier:), gated by the learning-governor preflight.',
  blender:
    'Loop ids beginning blender: — this prefix IS the scout-cadence registrant, so this is where this pot’s scout cycle is armed and budgeted. Edit the cycle budget below: the lane row is a mirror the next tick rewrites from it. The Scout section above is the workspace ceiling that bounds every one of them.',
  other:
    'Every remaining lane for this pot, named individually. Most lanes carry no family prefix, so this is usually where they are — nothing is filtered out.',
};

const EMPTY_NOTE: Record<PotDrawerSectionId, string> = {
  scout: 'The workspace scout ceiling could not be read.',
  gym: 'No gym autoloop is configured for this pot — it has never been set up, which is not the same as switched off.',
  frontier: 'No frontier: lanes for this pot.',
  blender: 'No blender: lane for this pot — its scout cadence has never registered one.',
  other: 'No other lanes for this pot.',
};

/**
 * Build the drawer for ONE pot.
 *
 * Takes the pot SLUG, never a chip — see the module header. A pot with no rows
 * at all still gets a complete five-section model, because "this pot has no
 * gym" is an answer and an omitted section is not.
 */
export function buildPotDrawer(
  arming: AutomationArming | null | undefined,
  potSlug: string,
  /**
   * The pot's `budget` settings override (P-013 / D-011), straight off the
   * `hive.overrides` sync query. Optional and `unknown` on purpose: it is a
   * user-authored JSON delta, validated in `drawerScoutBudget`, and a caller
   * that has not loaded it yet gets the engine defaults rather than a crash.
   */
  budgetConfig?: unknown,
): PotDrawerModel {
  const learning = arming ? potMasterSwitch(arming, potSlug) : 'unknown';
  const detail = potArmingDetail(arming, potSlug);

  const bySection = new Map<PotDrawerSectionId, PotDrawerField[]>();
  for (const id of POT_DRAWER_SECTION_IDS) bySection.set(id, []);

  bySection.get('scout')!.push(scoutField(arming?.scoutCeiling));
  if (detail.gym) bySection.get('gym')!.push(gymField(potSlug, detail.gym));

  // PARTITION: every lane lands somewhere. `laneSectionId` is total, so this
  // loop cannot drop a row — which is the property `placedLaneCount` pins.
  for (const lane of detail.lanes) {
    bySection.get(laneSectionId(lane.loopId))!.push(laneField(lane));
  }

  // P-013 / D-011: the pot's scout-cycle budget lives in the Blender section,
  // because `blender:<pot>` IS the scout-cadence registrant grain (D-009) and
  // this config is what that row is rebuilt from after every tick.
  const scoutCycleBudget = drawerScoutBudget(potSlug, budgetConfig);

  const sections = POT_DRAWER_SECTION_IDS.map<PotDrawerSection>((id) => {
    const fields = bySection.get(id)!;
    const configFields = id === 'blender' ? scoutCycleBudget : [];
    // The scout row always exists; it is "empty" only when the ceiling is unreadable.
    // A section holding CONFIG fields is never empty even with no lanes: a pot that
    // has never registered a blender lane can still set the budget the first cycle
    // will run under, and hiding that would strand exactly the pots D-009 measured
    // as owning no lanes at all.
    const empty =
      id === 'scout'
        ? arming?.scoutCeiling == null
        : fields.length === 0 && configFields.length === 0;
    // Blender can no longer BE empty (the budget is always editable), so its
    // "no lane registered" line would become dead text. It is still the true
    // thing to say for a pot with no `blender:` row, so it is said here instead
    // of quietly disappearing along with the empty state that used to carry it.
    const note =
      empty
        ? EMPTY_NOTE[id]
        : id === 'blender' && fields.length === 0
          ? `${EMPTY_NOTE.blender} Its cycle budget is still editable below — that is what the first registration will run under.`
          : SECTION_NOTE[id];
    return {
      id,
      title: SECTION_TITLE[id],
      note,
      fields,
      configFields,
      empty,
    };
  });

  const placed = sections
    .filter((s) => s.id !== 'scout' && s.id !== 'gym')
    .reduce((n, s) => n + s.fields.length, 0);

  return {
    potSlug,
    learning,
    sections,
    laneCount: detail.lanes.length,
    placedLaneCount: placed,
  };
}

/** Format a budget for display: never a bare number — the unit always rides along. */
export function formatBudget(budget: PotDrawerBudget): string {
  if (budget.usd === null) return `none set (${budget.unit})`;
  return `${budget.usd.toFixed(2)} ${budget.unit}`;
}
