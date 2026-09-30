/**
 * Slot registry + bundle kinds — the composition VOCABULARY an identity document
 * declares against (`identities-v1-2026-08-30` P-001; rulings D-007 as amended
 * 2026-09-03, the D-008 amendment, D-011, D-013, and P-001's own D-017).
 *
 * WHAT A SLOT IS. An identity is a blueprint document that declares the SLOTS it
 * fills (`slots: [{ slot, cardinality? }]` — D-013: the `slots:` key is the
 * identity discriminator; a document without it is an ordinary blueprint). Each
 * slot carries a CARDINALITY — `exclusive` (exactly one document per stack may
 * fill it; a second DISTINCT document on it is a composition hard-error, D-007)
 * or `additive` (documents stack) — and a LAYER, its position in the
 * deterministic layering order below. THE REGISTRY, NOT THE DOCUMENT, IS
 * AUTHORITATIVE for both: a document MAY restate `cardinality` for readability,
 * and `validateBlueprint` refuses a restatement that disagrees
 * (`slot-cardinality-mismatch`), so the two copies cannot drift.
 *
 * WHY A REGISTRY AND NOT A `kind`. D-007: what a profession/facet TYPE split
 * encoded was a cardinality constraint on ONE slot; paying for it with two
 * package kinds costs two lifecycles, two publish flows and two validation paths
 * to express one rule. A new axis is a new row HERE — no document-format change,
 * no new package kind.
 *
 * LAYERING ORDER (D-007 amendment): kernel → client → domain → fleet-posture →
 * modes → practices → instance. `kernel` and `instance` are RESERVED layers with
 * no declarable slot: the kernel is the sealed base (D-009 / P-003) and the
 * instance tier is the per-pot override (`pot_settings.promptOverride.<role>`).
 * A renderer walks layers in this order and renders the kernel LAST with an
 * explicit precedence statement (the seal) — see docs/COMPOSITION_MODEL.md.
 *
 * MODE AXES (D-008 amendment): one EXCLUSIVE slot per axis — additive ACROSS
 * axes, exclusive WITHIN one — so `auto + ideate` composes while two documents on
 * `autonomy` do not. The implication table (DRAIN ⇒ AUTO) and mode STATE are
 * kernel and live in `modes/registry.ts`; a document on a mode axis supplies only
 * the domain flavour of how that mode reads in its own vocabulary, never one byte
 * of authority (authority is computed by `instruction-lint.ts` from the registry
 * and enforced at the dispatch chokepoint — identity text is never an input).
 *
 * The registry is deliberately a TS constant, not a table: it is the vocabulary
 * the schema validates against, the merge algebra keys on, and the renderer
 * orders by — the same tier as `LISTING_KINDS` in the Cupboard. Growing it is a
 * plan decision (a new axis changes what can compose), not runtime data.
 */

/** The deterministic layering order (D-007 amendment). Index = precedence position. */
export const LAYER_ORDER = ['kernel', 'client', 'domain', 'fleet-posture', 'modes', 'practices', 'instance'] as const;
export type LayerId = (typeof LAYER_ORDER)[number];

/** Layers no document may declare a slot on: the sealed kernel + the per-pot instance tier. */
export const RESERVED_LAYERS: ReadonlySet<string> = new Set<LayerId>(['kernel', 'instance']);

export type SlotCardinality = 'exclusive' | 'additive';

/**
 * Every declarable slot, in LAYERING ORDER (the order a stack renders in). This
 * tuple is the one source the zod-independent `SlotId` type, `SLOT_REGISTRY`,
 * and the `slot-unknown` validation message all derive from.
 */
export const SLOT_IDS = [
  'client',
  'domain',
  'fleet-posture',
  'autonomy',
  'ideation',
  'objective',
  'grade',
  'test',
  'goal',
  'audit',
  'audience',
  'collaboration-stance',
  'practice',
] as const;
export type SlotId = (typeof SLOT_IDS)[number];

/** Mode axes — exclusive within each axis, additive across axes. GOAL renders
 * after GRADE/TEST so its delegated-build boundary remains explicit. */
export const MODE_AXES = ['autonomy', 'ideation', 'objective', 'grade', 'test', 'goal', 'audit', 'audience'] as const satisfies readonly SlotId[];
export type ModeAxis = (typeof MODE_AXES)[number];

export interface SlotSpecBody {
  cardinality: SlotCardinality;
  layer: Exclude<LayerId, 'kernel' | 'instance'>;
  /** What a document on this slot supplies. */
  fills: string;
  /** The plan decision that rules this slot's cardinality + position. */
  decision: string;
}
export interface SlotSpec extends SlotSpecBody {
  slot: SlotId;
}

/**
 * Keyed by `SlotId` so a slot added to `SLOT_IDS` without a spec (or vice versa)
 * is a TYPE error, not a runtime surprise.
 */
export const SLOT_SPECS: Readonly<Record<SlotId, SlotSpecBody>> = {
  client: {
    cardinality: 'exclusive',
    layer: 'client',
    fills:
      'the per-client tooling overlay (Claude / Codex / OMP) — the section the su prompt hand-splices today as CLIENT-TOOLING-OVERLAY',
    decision: 'D-007 amendment 2026-09-03',
  },
  domain: {
    cardinality: 'exclusive',
    layer: 'domain',
    fills:
      'the profession: what the work IS and how it is judged (papercusp-engineer, potato-salesman) — the engineering-discipline text of su.md',
    decision: 'D-007 ("exactly one profession per agent" becomes "the domain slot is exclusive")',
  },
  'fleet-posture': {
    cardinality: 'exclusive',
    layer: 'fleet-posture',
    fills:
      'the fleet ROLE playbook — member pull-loop style or leader monitoring / benching / claim-spec craft; the fleet PROTOCOL invariants stay kernel',
    decision: 'D-003 (playbooks leave the kernel) + D-007 (member-vs-leader is one exclusive slot)',
  },
  autonomy: {
    cardinality: 'exclusive',
    layer: 'modes',
    fills: 'the domain flavour of AUTO mode prose (state + what AUTO suspends stay kernel)',
    decision: 'D-008 amendment 2026-09-03 (one exclusive slot per mode axis)',
  },
  ideation: {
    cardinality: 'exclusive',
    layer: 'modes',
    fills: 'the domain flavour of IDEATE mode prose',
    decision: 'D-008 amendment 2026-09-03',
  },
  objective: {
    cardinality: 'exclusive',
    layer: 'modes',
    fills: 'the domain flavour of DRAIN mode prose (the DRAIN ⇒ AUTO implication is kernel)',
    decision: 'D-008 amendment 2026-09-03',
  },
  grade: {
    cardinality: 'exclusive',
    layer: 'modes',
    fills: 'the GRADE evaluation and repair practice; scoring and independent acceptance remain host-enforced',
    decision: 'SU mode/identity unification P-003 (2026-09-24)',
  },
  test: {
    cardinality: 'exclusive',
    layer: 'modes',
    fills: 'the TEST independent-verification practice; test subjects and permissions remain host-enforced',
    decision: 'SU mode/identity unification P-003 (2026-09-24)',
  },
  goal: {
    cardinality: 'exclusive',
    layer: 'modes',
    fills: 'the GOAL planning and delegated-execution practice; subject and authority remain host-enforced',
    decision: 'SU mode/identity unification P-003 (2026-09-24)',
  },
  audit: {
    cardinality: 'exclusive',
    layer: 'modes',
    fills: 'the domain flavour of AUDIT mode prose (read-only-toward-subject enforcement is kernel)',
    decision: 'D-008 amendment 2026-09-03',
  },
  audience: {
    cardinality: 'exclusive',
    layer: 'modes',
    fills:
      'who the agent is speaking to — the engineer-mode / novice-mode personas that `loadRoleModePersona` resolves from files today',
    decision: 'D-008 (unify the second mode axis) + amendment 2026-09-03',
  },
  'collaboration-stance': {
    cardinality: 'exclusive',
    layer: 'practices',
    fills:
      'how the agent works WITH the owner — the collaborator stance of su.md (address by name, confirm-before-execute posture, delivery discipline)',
    decision:
      'D-017 (P-001 ruling): exclusive — two stances toward one owner conflict rather than stack; sits on the practices layer per D-007’s order',
  },
  practice: {
    cardinality: 'additive',
    layer: 'practices',
    fills: 'a stackable working practice (compaction protocol, wait-loop discipline, peer-wake craft, …)',
    decision: 'D-007 ("practices stack because their slot is additive")',
  },
};

/** The registry in layering order — `SLOT_IDS` order, each joined with its spec. */
export const SLOT_REGISTRY: readonly SlotSpec[] = SLOT_IDS.map((slot) => ({ slot, ...SLOT_SPECS[slot] }));

/**
 * The Cupboard kinds an identity may bundle BY REFERENCE (D-011: one uniform
 * `bundles: [{ kind, ref, version }]` list, never a bespoke field per layer).
 * `recipe`, `rubric`, `knowledge-pack`, `plan`, `goal` are listing kinds today;
 * `datatype`, `event`, `rule` become kinds in M3 (P-027/P-028/P-029). There is
 * deliberately NO `skill` kind — removed by owner ruling 2026-09-02.
 *
 * `plan` and `goal` were absent until 2026-09-16 while both were already live
 * Cupboard listing kinds with their own publish verbs (`cupboard:publish-plan`,
 * `cupboard:publish-goal`) — so D-011's "one uniform list" was true of the TEXT
 * and false of the CODE, and an identity could not bundle the two kinds most
 * worth bundling. Added [owner 2026-09-15].
 */
export const BUNDLE_KINDS = ['recipe', 'rubric', 'knowledge-pack', 'plan', 'goal', 'datatype', 'event', 'rule'] as const;
export type BundleKind = (typeof BUNDLE_KINDS)[number];

export function isSlotId(x: unknown): x is SlotId {
  return typeof x === 'string' && (SLOT_IDS as readonly string[]).includes(x);
}

/** The registry entry for a slot id, or null for an id the registry does not know. */
export function slotSpec(slot: string): SlotSpec | null {
  return isSlotId(slot) ? { slot, ...SLOT_SPECS[slot] } : null;
}

export function layerIndex(layer: LayerId): number {
  return LAYER_ORDER.indexOf(layer);
}

/** A slot's position in the layering order (the index of its layer). */
export function slotLayerIndex(slot: SlotId): number {
  return layerIndex(SLOT_SPECS[slot].layer);
}

/**
 * Total order over slots: by layer, then by declaration order within the layer
 * (`SLOT_IDS` order — e.g. `collaboration-stance` before `practice`).
 */
export function compareSlotOrder(a: SlotId, b: SlotId): number {
  const byLayer = slotLayerIndex(a) - slotLayerIndex(b);
  if (byLayer !== 0) return byLayer;
  return SLOT_IDS.indexOf(a) - SLOT_IDS.indexOf(b);
}

/**
 * Where a DOCUMENT sits in a stack: the LOWEST layer index among the slots it
 * fills (a document filling `domain` + `fleet-posture` renders at `domain`).
 * Unknown slot ids are ignored (validation reports them); a document with no
 * known slot returns null — it is not an identity (or not a valid one).
 */
export function documentLayerIndex(slots: ReadonlyArray<{ slot: string }>): number | null {
  let min: number | null = null;
  for (const { slot } of slots) {
    if (!isSlotId(slot)) continue;
    const i = slotLayerIndex(slot);
    if (min == null || i < min) min = i;
  }
  return min;
}

export interface SlotClaim {
  /** The claiming document's id (a blueprint id). */
  id: string;
  slot: string;
}
export interface SlotConflict {
  slot: SlotId;
  /** The DISTINCT document ids claiming the exclusive slot, in claim order. */
  claimants: string[];
}

/**
 * The D-007 hard-error rule, as a pure function over a stack's per-layer claims:
 * an EXCLUSIVE slot claimed by two or more DISTINCT documents is a conflict.
 * The same document reached twice (diamond `extends`) is one claimant; additive
 * slots never conflict; unknown slot ids are skipped (validation's job). The
 * loader runs this over `LoadedBlueprint.layers` and fails the load on any hit.
 */
export function findExclusiveSlotConflicts(claims: ReadonlyArray<SlotClaim>): SlotConflict[] {
  const bySlot = new Map<SlotId, string[]>();
  for (const { id, slot } of claims) {
    if (!isSlotId(slot) || SLOT_SPECS[slot].cardinality !== 'exclusive') continue;
    const list = bySlot.get(slot) ?? [];
    if (!list.includes(id)) list.push(id);
    bySlot.set(slot, list);
  }
  const out: SlotConflict[] = [];
  for (const [slot, claimants] of bySlot) {
    if (claimants.length > 1) out.push({ slot, claimants });
  }
  return out;
}

/**
 * The registry as a Markdown table — embedded verbatim in
 * `docs/COMPOSITION_MODEL.md` between `<!-- SLOT-REGISTRY:BEGIN/END -->` markers
 * and asserted equal by `slots.test.ts`, so the prose can never describe a
 * registry other than this one (derived-truth ladder, rung 2: PIN).
 */
export function renderSlotRegistryMarkdown(): string {
  const lines: string[] = [];
  lines.push(`Layering order: ${LAYER_ORDER.map((l) => `\`${l}\``).join(' → ')} (reserved, no declarable slot: ${[...RESERVED_LAYERS].map((l) => `\`${l}\``).join(', ')}).`);
  lines.push('');
  lines.push('| slot | cardinality | layer | fills | ruling |');
  lines.push('|---|---|---|---|---|');
  for (const s of SLOT_REGISTRY) {
    lines.push(`| \`${s.slot}\` | ${s.cardinality} | ${s.layer} | ${s.fills} | ${s.decision} |`);
  }
  lines.push('');
  lines.push(`Bundle kinds (\`bundles[].kind\`, D-011): ${BUNDLE_KINDS.map((k) => `\`${k}\``).join(', ')} — no \`skill\` kind (owner ruling 2026-09-02).`);
  return lines.join('\n');
}
