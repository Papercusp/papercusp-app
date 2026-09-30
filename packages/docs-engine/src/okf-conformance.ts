/**
 * OKF v0.2 CONFORMANCE — the rules a doc must satisfy to carry the metadata
 * honestly (`okf-frontmatter-adoption-2026-08-08` P-006).
 *
 * P-001..P-004 put the fields ON the corpus and P-005 made them queryable at
 * read time. This module is what keeps that true: the shipped read surface is
 * only as good as the frontmatter behind it, and nothing in the pipeline
 * currently notices when a doc drifts back out of conformance.
 *
 * ## Why a lint, when there is already a Zod schema
 *
 * The Astro schema (`apps/operator-docs/src/content.config.ts`) validates the
 * agent-insights corpus at build time and is strictly stronger than this module
 * where it applies. It does not apply in three places, and each is a real hole:
 *
 *  1. **Optionality is not conformance.** `type` is `.optional()` in the schema
 *     — it has to be, or the declaration would have red the build on doc #1
 *     before the P-003 backfill (plan D-002). Now that the corpus is at 659/659,
 *     "every insight has `type`" is a rule only a lint can state.
 *  2. **The pack corpus has NO schema at all.** `knowledge-packs/**` is never
 *     seen by Astro, and — per plan D-003 — it is written by CODE, so it can
 *     regress one fleet-lesson adoption at a time with no author involved.
 *  3. **Zod checks SHAPE, not meaning.** `stale_after: z.union([z.string(),
 *     z.date()])` accepts the string `"soon"`, which the read surface then
 *     reports as `staleAfterUnparseable` — a doc whose expiry can never fire.
 *
 * ## The lossy-parser trap this module exists to avoid
 *
 * `parseOkfFrontmatter` DISCARDS what it cannot normalise: a `verified` entry
 * with no `by` disappears entirely, and a non-date `stale_after` is dropped
 * before it reaches `evaluateOkfTrust`. That is right for a reader (never invent
 * a verdict from an unreadable field) and exactly wrong for a checker — a lint
 * built on the normalised view would report a clean corpus while being blind to
 * the whole class of defect it was written to catch. So the rules below read the
 * RAW mapping (`parseFrontmatterBlock`) and use the normaliser only where its
 * judgement is the thing being tested (date parseability, via the same
 * `evaluateOkfTrust` the read surface calls). Same lesson as P-005's
 * `parseFrontmatter` block-parent blindness, one layer down.
 */

import {
  evaluateOkfTrust,
  normalizeOkfDate,
  okfFromObject,
  parseFrontmatterBlock,
} from './okf.js';

export type OkfConformanceRule =
  | 'frontmatter-missing'
  | 'frontmatter-unparseable'
  | 'missing-type'
  | 'verified-not-a-mapping'
  | 'verified-missing-by'
  | 'verified-missing-at'
  | 'stale-after-unparseable'
  | 'manifest-unparseable'
  | 'manifest-missing-okf-version'
  | 'manifest-okf-version-unusable';

export interface OkfViolation {
  rule: OkfConformanceRule;
  /** Human-readable specifics — the offending value, the entry index, the cause. */
  detail: string;
}

/** The manifest-level field carrying the OKF spec version (`pack-format.ts` mints it). */
export const OKF_MANIFEST_KEY = 'okf_version';

/** One line per rule, printed by the lint so a failure explains itself. */
export const OKF_CONFORMANCE_RULES: Record<OkfConformanceRule, string> = {
  'frontmatter-missing': 'no `---` frontmatter block at position 0 — the doc can carry no OKF metadata at all',
  'frontmatter-unparseable': 'the frontmatter block is not a YAML mapping',
  'missing-type': 'no `type:` — OKF\'s one mandatory field (free-form by spec; any non-empty string passes)',
  'verified-not-a-mapping': 'a `verified` entry is not a mapping (it must be `{ by, at }`)',
  'verified-missing-by': 'a `verified` entry has no `by:` — an unattributable verification claim',
  'verified-missing-at': 'a `verified` entry has no `at:` — an undatable verification claim',
  'stale-after-unparseable': '`stale_after:` is present but does not parse as a date, so the expiry can never fire',
  'manifest-unparseable': 'manifest.yaml is not a YAML mapping',
  'manifest-missing-okf-version': `no \`${OKF_MANIFEST_KEY}:\` — the pack does not declare which OKF revision it is authored against`,
  'manifest-okf-version-unusable': `\`${OKF_MANIFEST_KEY}:\` is present but empty or not scalar`,
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Check ONE document's frontmatter — an agent-insight `.mdx` or a knowledge-pack
 * `.md`. Both corpora carry the same four fields and answer to the same rules;
 * only the manifest is different (see `findOkfManifestViolations`).
 *
 * Returns `[]` for a conformant doc. Never throws: a checker that dies on the
 * first malformed input cannot report the population it was asked to measure.
 */
export function findOkfDocViolations(source: string): OkfViolation[] {
  const out: OkfViolation[] = [];
  const block = parseFrontmatterBlock(source);

  if (!block.present) {
    // A BOM defeats the leading-`---` match, so a file that plainly starts with
    // frontmatter reports as having none. Say so — otherwise the finding reads
    // as nonsense and gets dismissed as a broken lint rather than a broken doc.
    const bom = source.charCodeAt(0) === 0xfeff ? ' (file starts with a UTF-8 BOM, which hides the block from every OKF reader)' : '';
    out.push({ rule: 'frontmatter-missing', detail: `no frontmatter block${bom}` });
    return out;
  }
  if (!block.ok || !block.data) {
    out.push({ rule: 'frontmatter-unparseable', detail: block.error ?? 'unparseable' });
    return out;
  }

  const data = block.data;

  if (!isNonEmptyString(data.type)) {
    out.push({
      rule: 'missing-type',
      detail: data.type === undefined ? 'absent' : `unusable value: ${JSON.stringify(data.type)}`,
    });
  }

  // Spec: a bare `verified` mapping MUST be treated as a single-element list.
  // Read the RAW value, not the normalised one — `okfFromObject` silently drops
  // an entry with no `by`, which is the exact defect this rule is here to catch.
  const rawVerified = data.verified;
  if (rawVerified !== undefined && rawVerified !== null) {
    const entries = Array.isArray(rawVerified) ? rawVerified : [rawVerified];
    entries.forEach((entry, i) => {
      const where = entries.length > 1 ? ` (entry ${i + 1} of ${entries.length})` : '';
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        out.push({ rule: 'verified-not-a-mapping', detail: `${JSON.stringify(entry)}${where}` });
        return;
      }
      const rec = entry as Record<string, unknown>;
      if (!isNonEmptyString(rec.by)) {
        out.push({ rule: 'verified-missing-by', detail: `keys: [${Object.keys(rec).join(', ')}]${where}` });
      }
      // `at` may be authored unquoted, which js-yaml resolves to a Date — the
      // same both-shapes reality as `stale_after` (plan D-002), so normalise
      // before judging rather than demanding a string.
      if (normalizeOkfDate(rec.at) === undefined) {
        out.push({ rule: 'verified-missing-at', detail: `keys: [${Object.keys(rec).join(', ')}]${where}` });
      }
    });
  }

  if (data.stale_after !== undefined && data.stale_after !== null) {
    const fm = okfFromObject(data);
    if (!fm?.staleAfter) {
      // The normaliser refused the value outright (a boolean, a mapping, an
      // empty string) — it never even reached the date parser.
      out.push({
        rule: 'stale-after-unparseable',
        detail: `not a date-shaped value: ${JSON.stringify(data.stale_after)}`,
      });
    } else if (evaluateOkfTrust(fm).staleAfterUnparseable) {
      out.push({ rule: 'stale-after-unparseable', detail: `${JSON.stringify(fm.staleAfter)} does not parse as a date` });
    }
  }

  return out;
}

/**
 * Check one knowledge-pack `manifest.yaml`.
 *
 * Separate from the doc rules because the manifest carries the PACK-level
 * declaration (`okf_version`) and none of the per-doc fields. `parseManifest`
 * is a whitelist reader and `renderManifest` a whole-file REWRITE (plan D-003),
 * so this rule is what notices when a write path stops emitting the key.
 */
export function findOkfManifestViolations(source: string): OkfViolation[] {
  const parsed = parseYamlMapping(source);
  if (!parsed.ok || !parsed.data) {
    return [{ rule: 'manifest-unparseable', detail: parsed.error ?? 'unparseable' }];
  }
  const raw = parsed.data[OKF_MANIFEST_KEY];
  if (raw === undefined || raw === null) {
    return [{ rule: 'manifest-missing-okf-version', detail: 'absent' }];
  }
  // `okf_version: 0.2` unquoted is a YAML NUMBER — legal, and pack-format
  // stringifies it, so a number is conformant. Only empty/structured values are not.
  const usable = isNonEmptyString(raw) || typeof raw === 'number';
  if (!usable) {
    return [{ rule: 'manifest-okf-version-unusable', detail: JSON.stringify(raw) }];
  }
  return [];
}

/**
 * A manifest is bare YAML with no `---` fences, so it cannot go through
 * `parseFrontmatterBlock`. Parsed here via the same js-yaml instance, reached
 * through `parseFrontmatterBlock` by synthesising the fences — one YAML reader
 * for the whole module rather than a second import that could drift in options.
 */
function parseYamlMapping(source: string): { ok: boolean; data?: Record<string, unknown>; error?: string } {
  const body = source.replace(/\r\n/g, '\n').replace(/\n*$/, '');
  const block = parseFrontmatterBlock(`---\n${body}\n---\n`);
  return { ok: block.ok, data: block.data, error: block.error };
}

/**
 * Render violations as one line, or `null` when there are none — the same
 * contract as `formatNormativeViolations`, so both lints read alike.
 */
export function formatOkfViolations(violations: OkfViolation[]): string | null {
  if (violations.length === 0) return null;
  return violations.map((v) => `${v.rule} [${v.detail}]`).join('; ');
}
