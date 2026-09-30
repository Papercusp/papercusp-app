/**
 * pack-format — the Knowledge Pack format: types + pure parse/validate/filter
 * (learning-packs-2026-06-11 P-001).
 *
 * A knowledge pack is a versioned, git-canonical set of *learnings* — curated,
 * project-transferable working wisdom seeded into a hive's own mem0 store at
 * creation/install (copy, never live-link — D-001). On disk a pack is:
 *
 *   <pack-dir>/
 *     manifest.yaml          { id, title, description, version, author? }
 *     <item-id>.md           one learning per file:
 *                            --- frontmatter: id?, title, kind?, applies_to? ---
 *                            body = the learning text
 *
 * Built-in packs live next to the blueprints they ship with
 * (`libs/papercusp/packages/harness/knowledge-packs/`); Comb-installed packs land
 * under `~/.papercusp/knowledge-packs/` (see ./load-packs).
 *
 * Content doctrine (D-002): learnings carry invariant judgment as DISCOVERY
 * RULES ("find how this project runs tests"), never stack bindings ("use
 * Vitest"); `applies_to` tags filter what seeds by project shape.
 *
 * This module is PURE — no fs, no PG, no network — so the parser/validator
 * pins hard in unit tests; IO lives in ./load-packs and ./seed.
 */
/**
 * The GLOBAL fallback pack — used when neither an explicit `knowledgePack` arg
 * nor the blueprint's own `knowledge.pack` resolves (`_create.ts`:
 * `opts.knowledgePack ?? seed.packId ?? DEFAULT_KNOWLEDGE_PACK_ID`).
 *
 * EI-1539: this was `papercusp-default`, whose content is byte-identical to the
 * generic `coding` pack apart from three manifest lines (id/title/description).
 * A Papercusp-BRANDED id is the wrong global default for hives that have nothing
 * to do with Papercusp, so the generic pack is now the fallback and the branded
 * one is being retired. The UI pickers no longer hardcode it either — they
 * default per DOMAIN (`coding` / `work`).
 */
export declare const DEFAULT_KNOWLEDGE_PACK_ID = "coding";
/**
 * Project shapes a learning can apply to (D-002/D-008). `any` always seeds;
 * the rest seed only when blueprint detection reports a matching shape.
 * Repo-less hives (no detection) seed `any`-tagged items only (OQ-3 → D-008).
 */
export declare const APPLIES_TO_SHAPES: readonly ["ui", "service", "library", "cli", "any"];
export type AppliesTo = (typeof APPLIES_TO_SHAPES)[number];
/** Mirrors memory:remember's KINDS — a seeded learning is an ordinary memory row. */
export declare const LEARNING_KINDS: readonly ["user", "feedback", "project", "reference"];
export type LearningKind = (typeof LEARNING_KINDS)[number];
/** Provenance metadata value marking a memory row as pack-seeded (D-001). */
export declare const PACK_MEMORY_SOURCE = "pack";
/**
 * The Open Knowledge Format version this pack format targets
 * (okf-frontmatter-adoption-2026-08-08 P-004). Declared here rather than in the
 * codemod so the manifest field, the parser and the writer can never disagree
 * about which version a pack claims.
 */
export declare const OKF_VERSION = "0.2";
/** The on-disk manifest key carrying {@link OKF_VERSION} (camelCased in TS). */
export declare const OKF_MANIFEST_KEY = "okf_version";
export interface KnowledgePackManifest {
    /** Kebab-case pack id — globally unique (Comb listing_ref for published packs). */
    id: string;
    title: string;
    description: string;
    /** Three-part semver. Stamped on every seeded row for upgrade-diff (P-013). */
    version: string;
    author?: string;
    /**
     * OKF spec version the pack declares (`okf_version` on disk), e.g. '0.2'.
     * OPTIONAL and deliberately unvalidated beyond "a non-empty scalar": a pack
     * authored against a newer OKF revision must still load, per the spec's
     * tolerate-unknown rule.
     *
     * ⚠ This field exists because `parseManifest` is a WHITELIST constructor — it
     * builds a fresh object from named keys rather than spreading the parsed YAML,
     * so an on-disk key that is not read HERE is silently dropped and invisible to
     * every consumer. Writing `okf_version:` into a manifest.yaml without this
     * thread is decorative. The same applies on the way out: `renderManifest`
     * (knowledge-packs/candidates.ts) rewrites the fleet-lessons manifest on every
     * adoption, so a field it does not emit is ERASED from disk on the next write.
     */
    okfVersion?: string;
}
export interface LearningItem {
    /** Kebab-case, unique within the pack. Defaults from the filename stem. */
    id: string;
    /** One-line human title — prefixed onto the memory text on seed. */
    title: string;
    /** memory kind for the seeded row. Default 'feedback' (how-to-work wisdom). */
    kind: LearningKind;
    /** Project shapes this learning seeds for. Default ['any']. */
    appliesTo: AppliesTo[];
    /**
     * Topical domains this learning is relevant to (open kebab-case vocabulary,
     * e.g. 'replication', 'distributed-systems') — the second, orthogonal axis
     * to the closed shape axis above (EI-18121672688225947). Absent ⇒ untagged:
     * the item seeds/delivers everywhere, exactly as before the field existed.
     * Tagged items reach only hives that DECLARE a matching domain
     * (`knowledge-packs:domains` hive setting) — conservative beats
     * wrongly-seeded, mirroring the D-008 repo-less posture for shapes.
     */
    domains?: string[];
    /** The learning body (markdown; stored verbatim as the memory text). */
    text: string;
}
export interface KnowledgePack {
    manifest: KnowledgePackManifest;
    items: LearningItem[];
}
/** Where a pack was resolved from (./load-packs). */
export type KnowledgePackSource = 'builtin' | 'installed';
export interface KnowledgePackSummary {
    id: string;
    title: string;
    description: string;
    version: string;
    author?: string;
    itemCount: number;
    source: KnowledgePackSource;
}
/**
 * Numeric three-part-semver comparison: −1 / 0 / 1 for a<b / a==b / a>b.
 * Non-semver inputs sort BEFORE any valid version (so a malformed catalog
 * version never spuriously reads as "newer"). The one place version ordering
 * is decided — `updateAvailable` is `semverGt(catalog, installed)`, never a
 * raw string `!==` (which mis-reads 1.10.0 < 1.9.0 and flags downgrades as
 * upgrades). learning-packs-2026-06-11 P-013.
 */
export declare function compareSemver(a: string, b: string): -1 | 0 | 1;
/** True iff `a` is a strictly newer three-part semver than `b`. */
export declare function semverGt(a: string | undefined, b: string | undefined): boolean;
export declare function parseManifest(raw: string): {
    manifest?: KnowledgePackManifest;
    error?: string;
};
/**
 * Parse one `<item-id>.md`. Tolerant on optionals (kind/applies_to default),
 * strict on essentials (title, non-empty body) — packs are curated artifacts;
 * a malformed item should fail validation, not seed silently degraded.
 */
export declare function parseLearningFile(raw: string, fallbackId: string): {
    item?: LearningItem;
    error?: string;
};
/** Whole-pack validation. Empty array = valid. */
export declare function validatePack(pack: KnowledgePack): string[];
/**
 * Which items seed for a project of the given shapes (D-002/D-008)?
 * - `shapes` undefined/empty (repo-less hive, no detection): `any`-tagged only.
 * - shapes known: `any` + items intersecting the shapes.
 */
export declare function filterByShapes(items: readonly LearningItem[], shapes?: readonly AppliesTo[]): LearningItem[];
/**
 * Which items seed/deliver for a hive with the given DECLARED domains
 * (EI-18121672688225947)? Untagged items always pass — the field is opt-in
 * per item, so existing packs behave exactly as before. Domain-tagged items
 * pass only on intersection with the hive's declaration; a hive that declares
 * nothing (undefined/empty) receives untagged items only — conservative beats
 * wrongly-seeded, mirroring filterByShapes' repo-less posture.
 */
export declare function filterByDomains(items: readonly LearningItem[], declared?: readonly string[]): LearningItem[];
/**
 * The canonical memory-text render of a learning — one place, so seeded rows
 * are byte-identical across create/install/upgrade and the upgrade diff
 * (P-013) can detect "user edited this" by comparing against it.
 */
export declare function memoryTextOf(item: Pick<LearningItem, 'title' | 'text'>): string;
/** Provenance fields stamped into each seeded row's metadata (D-001). */
export interface PackProvenance {
    source: typeof PACK_MEMORY_SOURCE;
    pack_id: string;
    pack_version: string;
    pack_item_id: string;
}
export declare function provenanceOf(pack: KnowledgePack, item: LearningItem): PackProvenance;
