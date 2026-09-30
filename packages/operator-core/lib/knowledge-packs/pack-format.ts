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

import { parse as parseYaml } from 'yaml';
import { parseFrontmatter } from '../memory/insights-index';

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
export const DEFAULT_KNOWLEDGE_PACK_ID = 'coding';

/**
 * Project shapes a learning can apply to (D-002/D-008). `any` always seeds;
 * the rest seed only when blueprint detection reports a matching shape.
 * Repo-less hives (no detection) seed `any`-tagged items only (OQ-3 → D-008).
 */
export const APPLIES_TO_SHAPES = ['ui', 'service', 'library', 'cli', 'any'] as const;
export type AppliesTo = (typeof APPLIES_TO_SHAPES)[number];

/** Mirrors memory:remember's KINDS — a seeded learning is an ordinary memory row. */
export const LEARNING_KINDS = ['user', 'feedback', 'project', 'reference'] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

/** Provenance metadata value marking a memory row as pack-seeded (D-001). */
export const PACK_MEMORY_SOURCE = 'pack';

/**
 * The Open Knowledge Format version this pack format targets
 * (okf-frontmatter-adoption-2026-08-08 P-004). Declared here rather than in the
 * codemod so the manifest field, the parser and the writer can never disagree
 * about which version a pack claims.
 */
export const OKF_VERSION = '0.2';

/** The on-disk manifest key carrying {@link OKF_VERSION} (camelCased in TS). */
export const OKF_MANIFEST_KEY = 'okf_version';

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

/**
 * Doc-part kinds a pack doc may project as — the projecting subset of
 * `harness_doc_parts.kind` (`prose` never projects, so a pack never ships it).
 */
export const PACK_DOC_KINDS = ['invariant', 'pointer', 'recipe'] as const;
export type PackDocKind = (typeof PACK_DOC_KINDS)[number];

/**
 * A procedure/guide section a pack ships beside its learnings
 * (portable-identity-packages P-009 / D-022). On disk `docs/<id>.md`; installed
 * by an identity package as ONE doc part addressed to that exact installation
 * (`stack_scope {package:<resourceKey>}`), so only its wearers receive it.
 */
export interface PackDocItem {
  /** Kebab-case, unique among the pack's docs. Defaults from the filename stem. */
  id: string;
  title: string;
  /** The Project-guide section the part renders under (`target_section`). */
  section: string;
  kind: PackDocKind;
  /** The part body (markdown), stored verbatim. */
  body: string;
}

export interface KnowledgePack {
  manifest: KnowledgePackManifest;
  items: LearningItem[];
  /**
   * OPTIONAL and omitted when a pack ships none: the pack is pinned by content
   * hash, so an always-present empty array would change every existing pin.
   */
  docs?: PackDocItem[];
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

const KEBAB_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function isKebab(s: unknown): s is string {
  return typeof s === 'string' && KEBAB_RE.test(s);
}

/**
 * Numeric three-part-semver comparison: −1 / 0 / 1 for a<b / a==b / a>b.
 * Non-semver inputs sort BEFORE any valid version (so a malformed catalog
 * version never spuriously reads as "newer"). The one place version ordering
 * is decided — `updateAvailable` is `semverGt(catalog, installed)`, never a
 * raw string `!==` (which mis-reads 1.10.0 < 1.9.0 and flags downgrades as
 * upgrades). learning-packs-2026-06-11 P-013.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const av = SEMVER_RE.test(a);
  const bv = SEMVER_RE.test(b);
  if (!av || !bv) return av === bv ? 0 : av ? 1 : -1;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/** True iff `a` is a strictly newer three-part semver than `b`. */
export function semverGt(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return compareSemver(a, b) === 1;
}

/* ────────────────────────────────────────────────────────────────────────
 * Manifest
 * ──────────────────────────────────────────────────────────────────────── */

export function parseManifest(raw: string): { manifest?: KnowledgePackManifest; error?: string } {
  let obj: unknown;
  try {
    obj = parseYaml(raw);
  } catch (e) {
    return { error: `manifest.yaml parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { error: 'manifest.yaml must be a YAML mapping' };
  }
  const m = obj as Record<string, unknown>;
  if (!isKebab(m.id)) return { error: `manifest id missing or not kebab-case: ${String(m.id)}` };
  if (typeof m.title !== 'string' || !m.title.trim()) return { error: 'manifest title missing' };
  if (typeof m.description !== 'string' || !m.description.trim()) {
    return { error: 'manifest description missing' };
  }
  const version = typeof m.version === 'number' ? String(m.version) : m.version;
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    return { error: `manifest version must be three-part semver (got ${String(m.version)})` };
  }
  // `okf_version: 0.2` unquoted is a YAML NUMBER, and 0.20 would then stringify
  // as '0.2' — so accept both scalar shapes and normalize, exactly as `version`
  // above does. Not validated against a known set: unknown OKF versions must
  // load (see KnowledgePackManifest.okfVersion).
  const okfRaw = m[OKF_MANIFEST_KEY];
  const okfVersion =
    typeof okfRaw === 'number'
      ? String(okfRaw)
      : typeof okfRaw === 'string' && okfRaw.trim()
        ? okfRaw.trim()
        : undefined;

  return {
    manifest: {
      id: m.id,
      title: m.title.trim(),
      description: m.description.trim(),
      version,
      ...(typeof m.author === 'string' && m.author.trim() ? { author: m.author.trim() } : {}),
      ...(okfVersion ? { okfVersion } : {}),
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * Learning files
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Parse one `<item-id>.md`. Tolerant on optionals (kind/applies_to default),
 * strict on essentials (title, non-empty body) — packs are curated artifacts;
 * a malformed item should fail validation, not seed silently degraded.
 */
export function parseLearningFile(
  raw: string,
  fallbackId: string,
): { item?: LearningItem; error?: string } {
  const fm = parseFrontmatter(raw);
  if (!fm) return { error: `${fallbackId}: missing frontmatter block` };

  const end = raw.indexOf('\n---', 4);
  // parseFrontmatter returned non-null, so the closing fence exists.
  const afterFence = raw.indexOf('\n', end + 1);
  const text = (afterFence >= 0 ? raw.slice(afterFence + 1) : '').trim();
  if (!text) return { error: `${fallbackId}: empty learning body` };

  const id = typeof fm.id === 'string' && fm.id ? fm.id : fallbackId;
  if (!isKebab(id)) return { error: `${fallbackId}: id not kebab-case: ${id}` };

  const title = typeof fm.title === 'string' ? fm.title.trim() : '';
  if (!title) return { error: `${id}: title missing` };

  let kind: LearningKind = 'feedback';
  if (fm.kind !== undefined) {
    if (typeof fm.kind !== 'string' || !(LEARNING_KINDS as readonly string[]).includes(fm.kind)) {
      return { error: `${id}: kind must be one of ${LEARNING_KINDS.join('|')} (got ${String(fm.kind)})` };
    }
    kind = fm.kind as LearningKind;
  }

  let appliesTo: AppliesTo[] = ['any'];
  if (fm.applies_to !== undefined) {
    const arr = Array.isArray(fm.applies_to) ? fm.applies_to : [fm.applies_to];
    const bad = arr.filter((s) => !(APPLIES_TO_SHAPES as readonly string[]).includes(s));
    if (bad.length > 0) {
      return { error: `${id}: applies_to has unknown shape(s): ${bad.join(', ')}` };
    }
    if (arr.length === 0) return { error: `${id}: applies_to must not be empty` };
    appliesTo = [...new Set(arr)] as AppliesTo[];
  }

  let domains: string[] | undefined;
  if (fm.domains !== undefined) {
    const arr = Array.isArray(fm.domains) ? fm.domains : [fm.domains];
    if (arr.length === 0) return { error: `${id}: domains must not be empty when present` };
    const bad = arr.filter((d) => typeof d !== 'string' || !isKebab(d));
    if (bad.length > 0) {
      return { error: `${id}: domains must be kebab-case strings: ${bad.map(String).join(', ')}` };
    }
    domains = [...new Set(arr as string[])];
  }

  return { item: { id, title, kind, appliesTo, ...(domains ? { domains } : {}), text } };
}

/**
 * Parse one `docs/<doc-id>.md`. Strict like a learning: title, section and a
 * non-empty body are required — an installed doc part must name the section
 * it renders under (`projected_needs_section`).
 */
export function parsePackDocFile(
  raw: string,
  fallbackId: string,
): { doc?: PackDocItem; error?: string } {
  const fm = parseFrontmatter(raw);
  if (!fm) return { error: `docs/${fallbackId}: missing frontmatter block` };

  const end = raw.indexOf('\n---', 4);
  const afterFence = raw.indexOf('\n', end + 1);
  const body = (afterFence >= 0 ? raw.slice(afterFence + 1) : '').trim();
  if (!body) return { error: `docs/${fallbackId}: empty doc body` };

  const id = typeof fm.id === 'string' && fm.id ? fm.id : fallbackId;
  if (!isKebab(id)) return { error: `docs/${fallbackId}: id not kebab-case: ${id}` };

  const title = typeof fm.title === 'string' ? fm.title.trim() : '';
  if (!title) return { error: `docs/${id}: title missing` };

  const section = typeof fm.section === 'string' ? fm.section.trim() : '';
  if (!section) return { error: `docs/${id}: section missing` };

  let kind: PackDocKind = 'recipe';
  if (fm.kind !== undefined) {
    if (typeof fm.kind !== 'string' || !(PACK_DOC_KINDS as readonly string[]).includes(fm.kind)) {
      return { error: `docs/${id}: kind must be one of ${PACK_DOC_KINDS.join('|')} (got ${String(fm.kind)})` };
    }
    kind = fm.kind as PackDocKind;
  }

  return { doc: { id, title, section, kind, body } };
}

/* ────────────────────────────────────────────────────────────────────────
 * Pack-level validation + filtering
 * ──────────────────────────────────────────────────────────────────────── */

/** Whole-pack validation. Empty array = valid. */
export function validatePack(pack: KnowledgePack): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const item of pack.items) {
    if (seen.has(item.id)) errors.push(`duplicate learning id: ${item.id}`);
    seen.add(item.id);
  }
  const seenDocs = new Set<string>();
  for (const doc of pack.docs ?? []) {
    if (seenDocs.has(doc.id)) errors.push(`duplicate doc id: ${doc.id}`);
    seenDocs.add(doc.id);
  }
  // A docs-only pack is a procedure pack; a pack with neither teaches nothing.
  if (pack.items.length === 0 && seenDocs.size === 0) errors.push('pack has no learnings');
  return errors;
}

/**
 * Which items seed for a project of the given shapes (D-002/D-008)?
 * - `shapes` undefined/empty (repo-less hive, no detection): `any`-tagged only.
 * - shapes known: `any` + items intersecting the shapes.
 */
export function filterByShapes(
  items: readonly LearningItem[],
  shapes?: readonly AppliesTo[],
): LearningItem[] {
  const known: readonly AppliesTo[] = (shapes ?? []).filter((s) => s !== 'any');
  return items.filter(
    (it) => it.appliesTo.includes('any') || it.appliesTo.some((a) => known.includes(a)),
  );
}

/**
 * Which items seed/deliver for a hive with the given DECLARED domains
 * (EI-18121672688225947)? Untagged items always pass — the field is opt-in
 * per item, so existing packs behave exactly as before. Domain-tagged items
 * pass only on intersection with the hive's declaration; a hive that declares
 * nothing (undefined/empty) receives untagged items only — conservative beats
 * wrongly-seeded, mirroring filterByShapes' repo-less posture.
 */
export function filterByDomains(
  items: readonly LearningItem[],
  declared?: readonly string[],
): LearningItem[] {
  const has = new Set(declared ?? []);
  return items.filter(
    (it) => !it.domains || it.domains.length === 0 || it.domains.some((d) => has.has(d)),
  );
}

/**
 * The canonical memory-text render of a learning — one place, so seeded rows
 * are byte-identical across create/install/upgrade and the upgrade diff
 * (P-013) can detect "user edited this" by comparing against it.
 */
export function memoryTextOf(item: Pick<LearningItem, 'title' | 'text'>): string {
  return `${item.title} — ${item.text}`;
}

/** Provenance fields stamped into each seeded row's metadata (D-001). */
export interface PackProvenance {
  source: typeof PACK_MEMORY_SOURCE;
  pack_id: string;
  pack_version: string;
  pack_item_id: string;
}

export function provenanceOf(pack: KnowledgePack, item: LearningItem): PackProvenance {
  return {
    source: PACK_MEMORY_SOURCE,
    pack_id: pack.manifest.id,
    pack_version: pack.manifest.version,
    pack_item_id: item.id,
  };
}
