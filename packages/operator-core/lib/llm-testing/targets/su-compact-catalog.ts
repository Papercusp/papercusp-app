/**
 * COMPACT-tier catalog projection for the in-process `su` SUT
 * (deterministic-tool-definition-delivery-2026-09-21 P-011 / D-008 / D-012).
 *
 * WHY THIS EXISTS. D-008 makes agent COMPREHENSION a ship condition: a
 * projection that saves bytes but causes malformed calls is a regression, and
 * byte measurements cannot detect it. D-012 then measured that the obvious
 * instrument cannot answer it — `llm-test --target su` builds its Anthropic
 * `tools` array from `SU_CATALOG`, a HAND-AUTHORED constant, and nothing in
 * `lib/llm-testing` imports `applyCompactTier` / `compactInputSchema` /
 * `summaryGuidanceDescription`. So a green `llm-test` run says nothing about
 * the delivered projection, and recording one as P-011 evidence would be a
 * vacuous green: an instrument that measured none of the space, whose clean
 * result is indistinguishable from a real pass.
 *
 * WHAT THIS DOES. It rebuilds a `BuiltCatalog` by pushing every offered tool
 * through the SAME two functions the transport ships
 * (`summaryGuidanceDescription` + `compactInputSchema`, the pair
 * `applyCompactTier` applies and `compactWireBytes` prices), preferring the
 * LIVE registry's definition for each tool over the harness's curated stand-in.
 * That is the `buildCatalog(entries)` seam D-012 named; no parallel harness is
 * forked, and the scenarios, asserts and tool NAME set are untouched, so a
 * control-vs-compact A/B differs in exactly one variable: how much of each
 * definition the model was told.
 *
 * WHY EVERY TOOL AND NOT THE POLICY'S SUBSET. `CLAUDE_TOOL_DELIVERY.counts` is
 * `{ full: 0, compact: 63 }` — on the client this plan actually changed, EVERY
 * advertised tool ships compact. Projecting the whole offered set is therefore
 * the shipping condition, not a pessimisation.
 *
 * ⚠ FAILS LOUD, NEVER FALLS BACK WHOLESALE. `listAllProjectedTools()` returns
 * an EMPTY array when the agent-tools barrel has not registered
 * (EI-19377066316560032), and a silent fallback to the curated definitions
 * would produce exactly the vacuous green D-012 forbids — the run would look
 * like a compact-tier run and would not be one. A catalog below the plausible
 * floor throws.
 */
import type { BuiltCatalog } from './su-catalog';
import { sanitizeToolName } from './su-catalog';

/**
 * Below this, the registry did not finish registering. Kept well under the
 * real catalog size (~899 at authoring time) so ordinary catalog churn never
 * trips it, and well above any partial-registration slice.
 */
const MIN_PLAUSIBLE_CATALOG = 400;

export interface CompactTierProjection {
  /** The offered catalog, every definition projected onto its COMPACT form. */
  catalog: BuiltCatalog;
  /** Canonical names whose LIVE registry definition was projected. */
  usedLive: string[];
  /**
   * Canonical names absent from the live registry (plugin-provided tools such
   * as `design-phase:*` / `repomix:pack`), whose curated harness definition was
   * projected through the same functions instead. Reported so the evidence can
   * state its own coverage rather than imply the whole set was live.
   */
  fallback: string[];
  /** Serialized `{name, description, inputSchema}` bytes, before and after. */
  bytes: { full: number; compact: number };
  /** Tools the live registry advertises in total (the denominator's witness). */
  liveCatalogSize: number;
}

interface LiveDefinition {
  description?: string;
  inputSchema?: unknown;
}

/**
 * Memoised because the barrel import is the expensive part (~15 s) and a run
 * opens many sessions. Deliberately NOT `pinModuleState`: this is pure
 * memoisation of a deterministic read, so a duplicated module record costs one
 * recompute and can never split correctness — the condition that primitive
 * exists for.
 */
let liveDefinitionsPromise: Promise<Map<string, LiveDefinition>> | undefined;

async function loadLiveDefinitions(): Promise<Map<string, LiveDefinition>> {
  liveDefinitionsPromise ??= (async () => {
    // Side-effect import FIRST — it registers the catalog `listAllProjectedTools`
    // reads. Dynamic, because a bare static import of the barrel from here would
    // pull the whole agent-tool surface into every llm-testing consumer.
    await import('../../agent-tools/index.js');
    const { listAllProjectedTools } = await import('@papercusp/tooldef');
    const projected = listAllProjectedTools() as ReadonlyArray<{
      expose?: { mcp?: { name?: string } };
      description?: string;
      inputSchema?: unknown;
    }>;
    if (projected.length < MIN_PLAUSIBLE_CATALOG) {
      throw new Error(
        `su compact-tier catalog: the live registry returned only ${projected.length} tool(s), below the ` +
          `${MIN_PLAUSIBLE_CATALOG} floor — the agent-tools barrel did not finish registering. Refusing to ` +
          'project curated stand-ins as if they were the shipped definitions (that would be a vacuous green).',
      );
    }
    const live = new Map<string, LiveDefinition>();
    for (const t of projected) {
      const name = t.expose?.mcp?.name;
      if (name) live.set(name, { description: t.description, inputSchema: t.inputSchema });
    }
    return live;
  })();
  return liveDefinitionsPromise;
}

/** Exported for tests only — drop the memoised registry read. */
export function __resetLiveDefinitionsCache(): void {
  liveDefinitionsPromise = undefined;
}

function wireBytes(name: string, description: string, inputSchema: unknown): number {
  return Buffer.byteLength(JSON.stringify({ name, description, inputSchema }));
}

/**
 * Project an offered catalog onto the COMPACT delivery tier.
 *
 * Operates on a `BuiltCatalog` rather than on `SuCatalogEntry[]` so every
 * SuTarget-derived SUT (su, onboarding-tutor, pui-loop) can be projected with
 * no per-target wiring, and so the caller's own `opts.catalog` override is
 * honoured instead of silently replaced by `SU_CATALOG`.
 */
export async function projectCatalogToCompactTier(
  catalog: BuiltCatalog,
): Promise<CompactTierProjection> {
  const live = await loadLiveDefinitions();
  const { summaryGuidanceDescription, compactInputSchema } = await import('@papercusp/tooldef');

  const usedLive: string[] = [];
  const fallback: string[] = [];
  let fullBytes = 0;
  let compactBytes = 0;

  const tools: BuiltCatalog['tools'] = catalog.tools.map((t) => {
    const canonical = catalog.canonicalBySanitized.get(t.name) ?? t.name;
    const liveRow = live.get(canonical);
    if (liveRow) usedLive.push(canonical);
    else fallback.push(canonical);

    const sourceDescription = liveRow ? (liveRow.description ?? '') : t.description;
    const sourceSchema = liveRow ? (liveRow.inputSchema ?? {}) : t.input_schema;

    const description = summaryGuidanceDescription(sourceDescription);
    const projected = compactInputSchema(sourceSchema);
    // Anthropic requires input_schema.type === 'object'; the compact projection
    // preserves it, but a tool whose source schema was not an object would
    // otherwise smuggle a malformed request into the run and fail as if the
    // model had erred.
    const input_schema =
      projected && typeof projected === 'object' && (projected as { type?: unknown }).type === 'object'
        ? (projected as Record<string, unknown>)
        : { type: 'object' as const };

    fullBytes += wireBytes(canonical, sourceDescription, sourceSchema);
    compactBytes += wireBytes(canonical, description, input_schema);

    return { name: sanitizeToolName(canonical), description, input_schema };
  });

  return {
    catalog: { tools, canonicalBySanitized: catalog.canonicalBySanitized },
    usedLive,
    fallback,
    bytes: { full: fullBytes, compact: compactBytes },
    liveCatalogSize: live.size,
  };
}

/**
 * Below this share of the shipping seed resolving to a LIVE definition, the
 * run is not measuring the shipped surface and must fail loudly rather than
 * report a comparison it did not make. Calibrated against a real run (see the
 * `coverage` field) — deliberately not 1.0, because a handful of seed names
 * are plugin-provided and legitimately absent from the core registry.
 */
const MIN_SEED_LIVE_COVERAGE = 0.85;

export interface ShippingSeedCatalog {
  /** The offered catalog: exactly the shipping seed, at the requested tier. */
  catalog: BuiltCatalog;
  tier: 'full' | 'compact';
  /** Canonical names the delivery artifact says are DELIVERED to this kind. */
  seedNames: string[];
  /** Seed names whose LIVE registry definition was used. */
  usedLive: string[];
  /** Seed names absent from the live registry, therefore omitted entirely. */
  missingFromLive: string[];
  /** usedLive / seedNames. */
  coverage: number;
  /** Serialized `{name, description, inputSchema}` bytes for the built set. */
  bytes: number;
  liveCatalogSize: number;
}

/**
 * Build the catalog the SHIPPING configuration actually delivers, at a chosen
 * tier (deterministic-tool-definition-delivery-2026-09-21 D-019).
 *
 * WHY THIS EXISTS, and why it is NOT `projectCatalogToCompactTier`. That
 * function re-projects whatever catalog it is handed — for the `su` target
 * that is `SU_CATALOG`, a hand-authored constant. Measured 2026-09-22, that
 * constant overlaps the claude shipping seed by 27 of 63: 32 of its entries
 * are never delivered, and 36 delivered tools are absent from it. So an A/B
 * over it varies the tier on a surface that is 43% of what ships, which is
 * why D-012 concluded the instrument cannot answer D-008.
 *
 * This builds the tool set from the GENERATED delivery artifact instead — the
 * same file the launcher passes through as `PAPERCUSP_TOOLS_COMPACT` — so the
 * offered names are exactly the shipped names. DEFERRAL needs no simulation:
 * the other ~836 tools are absent from both arms by construction, so holding
 * the set fixed and varying only `tier` isolates the one variable D-008 asks
 * about.
 *
 * Fails closed on a thin registry read, exactly as `loadLiveDefinitions` does:
 * a silent fallback to curated stand-ins would look like a shipping-seed run
 * and would not be one.
 *
 * ⚠ `tier:'compact'` means PER-NAME, from the artifact's own `tiers` map — NOT
 * "compact everything" (D-046). This used to compact every seed name uniformly,
 * which was faithful only while the artifact read `{ full: 0, compact: 63 }`.
 * That premise expired on 2026-09-22T21:46Z, when a byte repair freed enough
 * budget to promote `coord:whoami` and `tools:invoke` to FULL. A uniform
 * projection then delivered LESS than what ships, and the difference was not
 * cosmetic: `tools:invoke` loses 475 B → 91 B of pure prose (its schema is
 * unchanged), including the name-format contract "Pass the exact tool name
 * (colon form…)". Two S25 blocks in that window duly emitted
 * `work_items__list`, reached no tool, and answered "no open work items found"
 * — a failure of the INSTRUMENT that the shipping seed does not have. An A/B
 * arm that over-compacts cannot bound the shipping configuration's regression;
 * it can only overstate it.
 *
 * `tier:'full'` remains the uniform all-full control arm: that is the contrast
 * D-008 asks for, and it is what the compact arm is judged against.
 */
export async function buildShippingSeedCatalog(
  tier: 'full' | 'compact',
  deliveryTiersOverride?: Readonly<Record<string, string>>,
): Promise<ShippingSeedCatalog> {
  const live = await loadLiveDefinitions();
  const mod = (await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- generated .mjs artifact, no type declarations by design
    '../../../../../apps/operator/scripts/tool-delivery.generated.mjs'
  )) as { CLAUDE_TOOL_DELIVERY?: { tiers?: Record<string, string> } };
  // A controlled tier map lets the D-046 regression exercise a full seed tool
  // even when the current generated artifact happens to ship all tools compact.
  const tiers = deliveryTiersOverride ?? mod.CLAUDE_TOOL_DELIVERY?.tiers;
  if (!tiers || Object.keys(tiers).length === 0) {
    throw new Error(
      'su shipping-seed catalog: tool-delivery.generated.mjs exposed no CLAUDE_TOOL_DELIVERY.tiers. ' +
        'Run `npm run gen:tool-delivery` — refusing to run an A/B against an empty seed.',
    );
  }
  const seedNames = Object.keys(tiers).sort();

  const { summaryGuidanceDescription, compactInputSchema } = await import('@papercusp/tooldef');

  const usedLive: string[] = [];
  const missingFromLive: string[] = [];
  const tools: BuiltCatalog['tools'] = [];
  const canonicalBySanitized = new Map<string, string>();
  let bytes = 0;

  for (const canonical of seedNames) {
    const row = live.get(canonical);
    if (!row) {
      missingFromLive.push(canonical);
      continue;
    }
    usedLive.push(canonical);
    const sourceDescription = row.description ?? '';
    const sourceSchema = row.inputSchema ?? {};
    // D-046: on the compact arm the per-name tier is the artifact's own verdict,
    // so a tool the seed ships FULL is delivered full here too. Anything other
    // than the literal 'full' compacts — an unrecognised tier must not be read
    // as a promotion.
    const compactThisOne = tier === 'compact' && tiers[canonical] !== 'full';
    const description = compactThisOne ? summaryGuidanceDescription(sourceDescription) : sourceDescription;
    const projected = compactThisOne ? compactInputSchema(sourceSchema) : sourceSchema;
    // Anthropic requires input_schema.type === 'object'; a tool whose source
    // schema is not an object would otherwise smuggle a malformed request into
    // the run and fail as if the model had erred.
    const input_schema =
      projected && typeof projected === 'object' && (projected as { type?: unknown }).type === 'object'
        ? (projected as Record<string, unknown>)
        : { type: 'object' as const };
    const sanitized = sanitizeToolName(canonical);
    canonicalBySanitized.set(sanitized, canonical);
    tools.push({ name: sanitized, description, input_schema });
    bytes += wireBytes(canonical, description, input_schema);
  }

  const coverage = seedNames.length === 0 ? 0 : usedLive.length / seedNames.length;
  if (coverage < MIN_SEED_LIVE_COVERAGE) {
    throw new Error(
      `su shipping-seed catalog: only ${usedLive.length} of ${seedNames.length} seed names ` +
        `(${(coverage * 100).toFixed(1)}%) resolved to a live definition, below the ` +
        `${(MIN_SEED_LIVE_COVERAGE * 100).toFixed(0)}% floor. Missing: ${missingFromLive.slice(0, 12).join(', ')}. ` +
        'Refusing to report an A/B over a surface that is not the shipped one.',
    );
  }

  return {
    catalog: { tools, canonicalBySanitized },
    tier,
    seedNames,
    usedLive,
    missingFromLive,
    coverage,
    bytes,
    liveCatalogSize: live.size,
  };
}
