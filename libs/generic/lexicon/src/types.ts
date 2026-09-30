/**
 * Core types for the lexicon resolver.
 *
 * A *term key* is a canonical, brand-neutral identifier for a domain
 * concept (e.g. `pot`, `fleet`). A *brand pack* maps every term key to its
 * display forms. The resolver picks the forms for the active pack and
 * applies the requested grammatical/casing options. Internal identifiers
 * (code, DB columns, tool names, repos) never change — only display labels.
 */

/** The brand packs this resolver ships. */
export type BrandPackId = 'classic' | 'the-hive';

/**
 * Built-in term keys. These are the brand-neutral Papercusp concept names; the pack
 * supplies the user-facing label. Keep this list the single source of truth —
 * every shipped pack must provide forms for every key (enforced by the type system
 * and the pack tests).
 *
 * App templates can add their own nouns without editing this union by using
 * `TermKey<'invoice' | 'customer'>` and `BrandPack<'invoice' | 'customer'>`.
 * The built-in packs stay exhaustive for the built-in keys only.
 */
export type BuiltInTermKey =
  | 'pot' // the top-level project / deployable grouping
  | 'fleet' // the live set of agents at work
  | 'operator' // the always-on coordination layer that can wake the brain
  | 'brain' // the high-judgment thinking/orchestration entity
  | 'overwatch' // the autonomous system-health supervisor (a brain sibling)
  | 'scout' // the autonomous idea-forager / creative-lens explorer
  | 'contributor' // any AI member
  | 'human' // any human member
  | 'chunk' // one worker-turn unit of a feature
  | 'cupboard' // the shared store of blueprints/snapshots/plugins
  | 'node' // a machine / region node a grouping spans
  | 'substrate' // the cross-agent coordination layer (marketing name)
  | 'blueprint' // a harness's declarative shape (kept in both packs)
  | 'harness' // one managed work-pipeline (kept in both packs)
  | 'signal'; // agent signals / handoffs

/** A term key set = Papercusp built-ins plus optional app-specific keys. */
export type TermKey<TCustom extends string = never> = BuiltInTermKey | TCustom;

/**
 * The display forms for one term. Forms are stored Title-Cased; the resolver
 * derives lowercase on demand. Plural is explicit (not derived) so irregulars
 * like Harness→Harnesses and Hive→Hives are always correct.
 */
export interface TermForms {
  /** Singular Title-Case label, e.g. "Hive". */
  one: string;
  /** Plural Title-Case label, e.g. "Hives". */
  other: string;
}

/** A complete brand pack: every term key mapped to its display forms. */
export interface BrandPack<TCustom extends string = never> {
  /** Stable id of the pack. */
  id: BrandPackId;
  /** Human-readable name, for admin/debug surfaces. */
  label: string;
  /** Term key → display forms. Must cover every {@link TermKey}. */
  terms: Record<TermKey<TCustom>, TermForms>;
}

/** Options controlling which form/casing a resolution returns. */
export interface TermOptions {
  /** Return the plural form. Ignored when `count` is provided. */
  plural?: boolean;
  /**
   * Numeric count — selects singular (1 / -1) vs plural (everything else)
   * automatically. Overrides `plural`.
   */
  count?: number;
  /**
   * Lowercase the resolved label (for mid-sentence use). Multi-word labels
   * lowercase every word ("Hive Mind" → "hive mind").
   */
  lower?: boolean;
}
