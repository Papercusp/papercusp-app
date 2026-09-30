/**
 * field-reliability-registry.ts — the GUARD that makes `field-reliability.ts`'s convention stick.
 *
 * ## What this is NOT
 *
 * It does not state the rule. {@link ./field-reliability} already states it well, and states it
 * once: *a surface must not render an absent, unreliable or unanswered result as a real one.* This
 * module adds no second vocabulary — every entry here is built with that module's own `caveat()`,
 * carrying its own `cannotAnswer` + `insteadRead` fields.
 *
 * What was missing was ENFORCEMENT. `field-reliability.ts`'s own module doc names six ad-hoc
 * spellings of the idea (`containment_warning`, `zeroHitCaveat`, `okFalseWarning`, `fieldMissHelp`,
 * `priorWorkWarning`, `stateWarning`) and its complaint about them is precise: *"they are prose, so
 * nothing can enumerate them, test them, or render them consistently."* Stating a convention does
 * not make a seventh spelling detectable. This registry is what enumerates and tests them.
 *
 * ## Why keyed by (SURFACE, FIELD) — the two obvious designs were measured and rejected
 *
 * Plan `silent-wrong-answers-2026-08-01`, D-104:
 *
 * **REJECTED — lint on the field-NAME pattern** (`*Warning`/`*Caveat`/`*Hint`/`*Help`/`*Note`), to
 * catch a seventh spelling being invented. Measured over `packages/operator-core/lib`: 96 distinct
 * matching names, and the top of the distribution is ordinary domain content — `carryNote` (56
 * uses), `routeHint` (47), `awaitingNote` (15), `aliasNote` (14), `journalNote` (13). The genuinely
 * epistemic ones (`priorWorkWarning` 6, `stateWarning` 3, `_fieldReliabilityWarning` 5) are a buried
 * minority. Such a lint has no separation between the population it must catch and the one it must
 * not, so it can only be tuned into uselessness or disabled.
 *
 * **REJECTED — a registry keyed by FIELD NAME, auto-attaching wherever that field appears.**
 * `endedAt` names two unrelated concepts in this tree: an adv_session end (unreliable,
 * sweeper-written) and a `capability:bash` job end (a real observation — `bash-jobs.ts` sets it from
 * `Date.now()` at actual completion). Field-keyed attachment would caveat the bash job wrongly, i.e.
 * MANUFACTURE a false warning — this plan's own bug with the sign flipped, which is strictly worse
 * than the silence it replaces because a warning is trusted. `exitCode`, `startedAt` and `status`
 * are overloaded the same way.
 *
 * So the key is the pair. One entry per EMITTING SITE, and the generalisation D-104 draws from
 * every rejected design in that plan is the reason:
 *
 *   **A guard keyed on a NAME is a guess about intent; a guard keyed on a REGISTERED SITE is a
 *   fact.** Every design this plan rejected failed by keying on a proxy — a name, a count, a ratio,
 *   a timestamp — instead of on the thing itself.
 *
 * ## The two lists, and the ratchet between them
 *
 * **{@link FIELD_RELIABILITY_SITES}** — sites that have MIGRATED to the shared vocabulary. Each
 * entry names the file that must attach it, and `field-reliability-registry.test.ts` reads that file
 * and asserts the `caveatForSite(surface, field)` call is really there. A registered site that stops
 * attaching fails the build; `caveatForSite` throwing on an unregistered pair closes the other
 * direction, so registry and code cannot drift apart in either.
 *
 * **{@link UNMIGRATED_CAVEAT_SPELLINGS}** — the ad-hoc spellings that have NOT migrated yet, on the
 * repo's established shrink-only model (`KNOWN_DARK_FLAGS` + `DARK_FLAGS_HIGH_WATERMARK`, and the
 * empty baseline of `lint:no-raw-setinterval`). It may only SHRINK: migrating one deletes its entry,
 * and {@link UNMIGRATED_CAVEAT_HIGH_WATERMARK} must come down with it. A hard "all must migrate"
 * gate would fail on day one against eight live sites and be disabled within the hour; the ratchet
 * lands the guard NOW and lets the migration proceed site-by-site without ever regressing.
 *
 * That is the actual goal — catching instance #7 at REVIEW rather than filing it afterwards. A
 * seventh spelling must now either use the shared vocabulary or be added here deliberately, with a
 * justification, past a watermark that does not move quietly.
 */

import { caveat, type FieldCaveat, type FieldReliability } from './field-reliability';

/**
 * One registered emitting site: a specific FIELD on a specific SURFACE, which is required to attach
 * its caveat through {@link caveatForSite}.
 *
 * `surface` is the name an agent sees the result under (`release:checkpoint-run`, `code:run`), not
 * the module that computes it — the reader who must not misread the field knows the tool, not the
 * call graph.
 */
export interface EpistemicSite {
  /** Agent-visible surface the field is rendered on, e.g. `release:checkpoint-run`. */
  surface: string;
  /** The field's key as it appears in that result (dotted for nesting). */
  field: string;
  /**
   * Repo-relative path of the file that MUST attach this caveat. The coverage test reads this file
   * and asserts the `caveatForSite` call is present — which is what makes the entry a fact about
   * the code rather than a claim about it.
   */
  emittedIn: string;
  reliability: Exclude<FieldReliability, 'observed'>;
  /** ONE line naming the question this field CANNOT answer. Phrased as the question, not as advice. */
  cannotAnswer: string;
  /** The surface that CAN answer it. Required — an unreliable field with no alternative is a dead end. */
  insteadRead: string;
  /** Evidence/provenance (an EI id, a measurement, a file:line). */
  because?: string;
}

/**
 * The registry's composite key.
 *
 * JSON-encoded rather than joined on a separator: surfaces already contain `:`
 * (`release:checkpoint-run`), so any single-character separator makes `(a:b, c)` and `(a, b:c)`
 * collide. Encoding the pair keeps the key unambiguous, greppable, and free of the control bytes
 * `lint:no-control-bytes` (a green-checkpoint leg) rejects.
 */
export function siteKey(surface: string, field: string): string {
  return JSON.stringify([surface, field]);
}

/**
 * Every (surface, field) that has MIGRATED to the shared vocabulary.
 *
 * To add one: move the caveat's text here, replace the inline `caveat({...})` at the emitting site
 * with `caveatForSite('<surface>', '<field>')`, and delete the site's row from
 * {@link UNMIGRATED_CAVEAT_SPELLINGS} (lowering {@link UNMIGRATED_CAVEAT_HIGH_WATERMARK} with it).
 */
export const FIELD_RELIABILITY_SITES: readonly EpistemicSite[] = [
  {
    // The first migrated site, and the one the whole convention was written for: the 2026-08-02
    // post-mortem's headline field. Four careful agents produced four contradictory verdicts in
    // ninety minutes, each reasoning correctly from this field, because nothing said it was a
    // re-read of a moving HEAD rather than the sha the run actually holds.
    surface: 'release:checkpoint-run',
    field: 'candidate',
    emittedIn: 'packages/operator-core/lib/agent-tools/release/checkpoint-run.ts',
    reliability: 'inferred',
    cannotAnswer: 'Which sha is this run judging?',
    insteadRead:
      "in_flight_retriage.refiring_candidate, or gate_health->'inFlightRetriage'/'inFlightCandidate' in harness_shared.routines",
    because:
      "read from the checkpoint checkout's live HEAD at release-checkpoint-launch.ts:686, not from the running process",
  },
];

const SITES_BY_KEY: ReadonlyMap<string, EpistemicSite> = new Map(
  FIELD_RELIABILITY_SITES.map((site) => [siteKey(site.surface, site.field), site]),
);

/** The registered site for a (surface, field) pair, or `null` when the pair is not registered. */
export function lookupSite(surface: string, field: string): EpistemicSite | null {
  return SITES_BY_KEY.get(siteKey(surface, field)) ?? null;
}

/**
 * Build the {@link FieldCaveat} for a REGISTERED emitting site.
 *
 * THROWS on an unregistered pair, and that is the point: it closes the direction the coverage test
 * cannot see. The test walks registry → code (every registered site really attaches); this walks
 * code → registry (a site cannot attach a caveat the registry has never heard of, so a seventh
 * spelling cannot be introduced through this function without being registered first).
 *
 * A throw is safe here because the pair is a literal in the calling source: an unregistered pair is
 * a build-time authoring error that the site's own tests hit immediately, never a runtime input.
 */
export function caveatForSite(surface: string, field: string): FieldCaveat {
  const site = lookupSite(surface, field);
  if (!site) {
    throw new Error(
      `field-reliability: no registered site for (${surface}, ${field}). ` +
        `Register it in FIELD_RELIABILITY_SITES (packages/operator-core/lib/field-reliability-registry.ts) ` +
        `with its cannotAnswer + insteadRead, rather than inventing another ad-hoc caveat field.`,
    );
  }
  return caveat({
    field: site.field,
    reliability: site.reliability,
    cannotAnswer: site.cannotAnswer,
    insteadRead: site.insteadRead,
    ...(site.because ? { because: site.because } : {}),
  });
}

/**
 * An ad-hoc caveat spelling that has NOT migrated to the shared vocabulary yet.
 *
 * This list may only SHRINK. Each row is a real emitting site, verified by the coverage test against
 * the file it names — so a row cannot be parked here for a site that no longer exists, and a site
 * that HAS migrated must have its row deleted.
 */
export interface UnmigratedCaveatSpelling {
  /** Agent-visible surface the ad-hoc field is rendered on. */
  surface: string;
  /** The ad-hoc field name as emitted today. */
  field: string;
  /** Repo-relative file that emits it. The coverage test asserts the field name is still there. */
  emittedIn: string;
  /** Why it has not migrated yet — what a migration would have to preserve. */
  why: string;
}

/**
 * The eight live sites behind the six ad-hoc NAMES `field-reliability.ts` complains about.
 *
 * Eight sites from six names is the clearest possible argument for keying on the pair: `zeroHitCaveat`
 * and `priorWorkWarning` each render on two different surfaces, answering two different questions, so
 * a name-keyed registry could not have carried the right `cannotAnswer` for either.
 */
export const UNMIGRATED_CAVEAT_SPELLINGS: readonly UnmigratedCaveatSpelling[] = [
  {
    surface: 'release:checkpoint-run',
    field: 'containment_warning',
    emittedIn: 'packages/operator-core/lib/agent-tools/release/checkpoint-run.ts',
    why: 'Carries two different shapes through one key — a rendered RefusedAnswer or a containment warning string. Migrating means splitting the refusal out, which changes the reply shape.',
  },
  {
    surface: 'search:semantic',
    field: 'zeroHitCaveat',
    emittedIn: 'packages/operator-core/lib/agent-tools/search/semantic.ts',
    why: 'A 0-hit result when the embedder is unavailable — an absence that reads as a real negative. Migrating means attaching to the empty result set rather than to a named field.',
  },
  {
    surface: 'sessions:search',
    field: 'zeroHitCaveat',
    emittedIn: 'packages/operator-core/lib/agent-tools/sessions/search.ts',
    why: 'Same field NAME as search:semantic, different question: verbatim-mode substring miss and tool-part exclusion, not embedder availability. Composed from up to three caveats joined into one string.',
  },
  {
    surface: 'code:run',
    field: 'okFalseWarning',
    emittedIn: 'packages/operator-core/lib/agent-tools/code/run.ts',
    why: 'Warns that a child dispatch returned ok:false inside an otherwise-ok script. Deliberately complementary to fieldMissHelp; migrating both together preserves that non-overlap.',
  },
  {
    surface: 'code:run',
    field: 'fieldMissHelp',
    emittedIn: 'packages/operator-core/lib/agent-tools/code/run.ts',
    why: 'Reports reads of absent result fields with didYouMean. The strongest live instance of this bug class, and the one that caught three misreads while this guard was authored — migrate carefully, its correction shape is load-bearing.',
  },
  {
    surface: 'work_items:get',
    field: 'priorWorkWarning',
    emittedIn: 'packages/operator-core/lib/agent-tools/work_items/get-shape.ts',
    why: 'Clipped to a per-tier cap at the shaping layer, so the migrated form must survive truncation without losing insteadRead.',
  },
  {
    surface: 'scheduler:get_next',
    field: 'priorWorkWarning',
    emittedIn: 'packages/operator-core/lib/agent-tools/scheduler/get_next.ts',
    why: 'Same field NAME as work_items:get, different question: prior work on an item being CLAIMED, not one being read. Threaded through the claim legs, so migration touches the claim path.',
  },
  {
    surface: 'work_items:complete',
    field: 'stateWarning',
    emittedIn: 'packages/operator-core/lib/agent-tools/work_items/complete.ts',
    why: 'Suppressed for terminal final states by design (D-004), so the migrated form must keep the suppression rather than always attaching.',
  },
];

/**
 * The ceiling on {@link UNMIGRATED_CAVEAT_SPELLINGS}, enforced by the coverage test.
 *
 * SHRINK-ONLY, exactly like `DARK_FLAGS_HIGH_WATERMARK`: migrating a site lowers this number with
 * it. Raising it means adding a seventh ad-hoc spelling instead of using the shared vocabulary —
 * which is the thing this guard exists to prevent, so it needs an explicit justification in the
 * entry's `why` and should be argued for, not appended.
 */
export const UNMIGRATED_CAVEAT_HIGH_WATERMARK = 8;
