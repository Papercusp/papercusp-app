/**
 * Shared top-level priority for coord:orient assembly and floor-budget eviction.
 *
 * The serialized result's insertion order is meaningful: the result door keeps the
 * head when it must spill. The same ranking also tells the domain shaper which
 * recoverable optional legs it may omit after every semantic cap has reached its
 * floor. Keeping this as data prevents the assembler's order and the shaper's
 * eviction policy from drifting apart.
 */

export interface OrientOptionalLeg {
  /** Stable logical leg name used in omission disclosures. */
  readonly name: string;
  /** Top-level fields emitted by this leg, in assembly order. */
  readonly fields: readonly string[];
  /** Exact path that recovers or re-delivers the omitted data. */
  readonly recoverVia: string;
}

/**
 * `facts:list` is scoped by the serving tool, so `all:true` is only useful when
 * each selector is named. The orient fold currently reads workspace + owner and
 * optionally harness facts; keep all three recovery calls in one shared pointer
 * so the result shaper and omission disclosures cannot drift.
 */
export const ORIENT_FACTS_RECOVERY_VIA =
  "facts:list { scope:'workspace', all:true, full:true }; facts:list { scope:'owner', scopeRef:'<ownerId>', all:true, full:true }; if a harness selector was folded, facts:list { scope:'harness', scopeRef:'<harness>', all:true, full:true }";

/** Result fields that are never eligible for optional-leg eviction. */
export const ORIENT_CORE_RESULT_KEYS = [
  'ok',
  'me',
  'claimable',
  'claimableHarnessScope',
  'claimableTruncated',
  'inbox',
  'presenceDrift',
  'recoveredFleetScope',
  'laneClaim',
  'leaderBrief',
  'fleetSummaries',
  'fleetSummariesTruncated',
  'goalPortfolio',
  'obligations',
] as const;

/**
 * Priority is highest to lowest within each tier. Tier 3 is re-delivered by the
 * standing transition substrate; tier 4 is independently re-fetchable. The
 * floor shaper therefore evicts the tail of tier 4 before the tail of tier 3.
 *
 * Companion disclosure fields are grouped with their payload. Dropping a list
 * while leaving its `*Truncated` marker (or vice versa) would turn the marker into
 * a misleading orphan, so a logical leg is the atomic eviction unit.
 */
export const ORIENT_OPTIONAL_PRIORITY = {
  tier3: [
    {
      name: 'ownerDirectives',
      fields: ['ownerDirectives'],
      recoverVia: 'next system prompt / CTRL:transition (automatic re-delivery)',
    },
    { name: 'modes', fields: ['modes'], recoverVia: 'next system prompt / CTRL:transition (mode registry)' },
    {
      name: 'instructionPrecedence',
      fields: ['instructionPrecedence'],
      recoverVia: 'next system prompt / CTRL:transition (effective precedence)',
    },
    { name: 'ideate', fields: ['ideate'], recoverVia: "blender:ideation-feedback { scope:'mine', intent }" },
    {
      name: 'captureMiss',
      fields: ['captureMiss'],
      recoverVia: 'next system prompt / CTRL:transition (automatic re-delivery)',
    },
    {
      name: 'configIntegrity',
      fields: ['configIntegrity'],
      recoverVia: 'next system prompt / CTRL:transition (automatic re-delivery)',
    },
    {
      name: 'codexLocks',
      fields: ['codexLocks'],
      recoverVia: 'coord:orient (lock mode is re-delivered on the next orient)',
    },
    {
      name: 'taskToolSchemaPack',
      fields: ['taskToolSchemaPack'],
      recoverVia: 'coord:orient (the activated task schema pack is re-delivered after compaction)',
    },
  ] as const satisfies readonly OrientOptionalLeg[],
  tier4: [
    {
      name: 'facts',
      // P-004 / D-006: factsFoldTruncated is the DATABASE bound (the fold's LIMIT
      // never returned the rest); factsTruncated beside it is the PAYLOAD bound
      // (returned rows dropped to fit the budget). They compose, so both ride the
      // same leg — dropping either one leaves a reader under-counting the corpus.
      fields: [
        'facts',
        'factsWithheld',
        'factsNarrowed',
        'factsFoldTruncated',
        'factsTruncated',
        'factsBodiesTruncated',
      ],
      recoverVia: ORIENT_FACTS_RECOVERY_VIA,
    },
    {
      name: 'factEvictionDisclosures',
      fields: ['factEvictionDisclosures'],
      recoverVia: ORIENT_FACTS_RECOVERY_VIA,
    },
    { name: 'host', fields: ['host'], recoverVia: 'next coord:orient (host snapshot is always re-delivered)' },
    { name: 'memory', fields: ['memory'], recoverVia: 'memory:search { query }' },
    { name: 'planNow', fields: ['planNow'], recoverVia: 'plans:get { slug }' },
    { name: 'planEvents', fields: ['planEvents'], recoverVia: 'coord:plan-events' },
    { name: 'fleetControl', fields: ['fleetControl'], recoverVia: 'fleet:assignments' },
    { name: 'fleetCatchUp', fields: ['fleetCatchUp'], recoverVia: "coord:catch-up { audience:'@fleet:<slug>' }" },
    { name: 'fleetHealth', fields: ['fleetHealth'], recoverVia: 'coord:glance' },
    { name: 'announcedGates', fields: ['announcedGates', 'announcedGatesTruncated'], recoverVia: 'events:catalog' },
    { name: 'paneContext', fields: ['paneContext'], recoverVia: 'curation:state-of-pot / fleet:assignments' },
    { name: 'deepWork', fields: ['deepWork'], recoverVia: 'coord:inbox' },
    { name: 'recipes', fields: ['recipes', 'recipesTruncated'], recoverVia: 'recipes:search' },
    {
      name: 'peersKnow',
      fields: ['peersKnow'],
      recoverVia:
        "consult:get_feedback { question: '<your intent>' } (archive-first serves settled questions instantly)",
    },
    { name: 'pipeline', fields: ['pipeline'], recoverVia: 'dev:pipeline_position { path }' },
    {
      name: 'governor',
      fields: ['governor'],
      recoverVia: "state:read { cell: 'governor.health' } plus governor.admission/queue/resources/recovery",
    },
    // P-011 (state-plane-interest-and-hardening-2026-08-21). ADDITIVE, and namespaced
    // under its own leg so it composes with fleet-spec-scoped-metrics P-007's leader
    // fold on this same file rather than altering it (D-005).
    //
    // Tier 4 is correct and not a demotion: the leg carries HANDLES ONLY (D-001), so
    // everything it says is recoverable by the one call named here — which is exactly
    // the tier-4 contract ("independently re-fetchable"). Losing it under budget
    // pressure costs a pointer, never a reading.
    {
      name: 'interest',
      fields: ['interest'],
      recoverVia: 'state:read (no args) lists every cell you may read',
    },
    { name: 'intentDeclared', fields: ['intentDeclared'], recoverVia: 'coord:declare-intent' },
    { name: 'fleetDelta', fields: ['fleetDelta'], recoverVia: 'fleet:assignments' },
    { name: 'ownerPresent', fields: ['ownerPresent'], recoverVia: 'next coord:orient (owner presence is re-measured)' },
  ] as const satisfies readonly OrientOptionalLeg[],
} as const;

/** High-to-low insertion order for the result assembler. */
export const ORIENT_OPTIONAL_ASSEMBLY_PRIORITY: readonly OrientOptionalLeg[] = [
  ...ORIENT_OPTIONAL_PRIORITY.tier3,
  ...ORIENT_OPTIONAL_PRIORITY.tier4,
];

/** Low-to-high eviction order for the floor shaper. */
export const ORIENT_OPTIONAL_EVICTION_PRIORITY: readonly (OrientOptionalLeg & { readonly tier: 3 | 4 })[] = [
  ...[...ORIENT_OPTIONAL_PRIORITY.tier4].reverse().map((leg) => ({ ...leg, tier: 4 as const })),
  ...[...ORIENT_OPTIONAL_PRIORITY.tier3].reverse().map((leg) => ({ ...leg, tier: 3 as const })),
];
