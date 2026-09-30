/**
 * Partial-guidance projection — the middle detail tier for a tool's PROSE,
 * mirroring what `compact-schema.ts` does for its SCHEMA.
 *
 * WHY THIS EXISTS. The COMPACT delivery tier drops `description` entirely
 * (`compactWireBytes` measures `description: ''`, and the transport seam's
 * `applyCompactTier` matches it exactly). That is a real cost, not a rounding
 * error: on the MCP `tools/list` wire `description` is the ONLY prose field a
 * tool carries, so a compact tool reaches the model as a bare name plus a
 * schema. Nothing tells it what the tool is FOR. A tool advertised with no
 * prose is barely better than a deferred one — and it is worse in one specific
 * way, because it occupies a seat while still being unidentifiable.
 *
 * THE CONTRACT. Partial keeps the part of the prose that answers "should I
 * reach for this tool at all" and drops the part that answers "and how does it
 * combine with others":
 *
 *   KEPT     the `when` section, verbatim — the selection signal
 *   KEPT     every hard refusal / safety clause, wherever it appears — the
 *            sentences whose loss could cause a DESTRUCTIVE or forbidden call
 *   DROPPED  the rest of `notWhen` and `chaining` prose
 *
 * ⚠ THIS IS A LOSSY PROJECTION AND SAYS SO. `compactInputSchema` can honestly
 * claim to preserve the callable contract, because everything it removes is
 * advisory to a JSON validator. Prose has no such separation — dropping
 * `chaining` genuinely removes information a model might have used. So this
 * module does not assert "no information lost"; it MEASURES what it removed
 * (`partialGuidanceLoss`) so the trade can be argued from numbers. A projection
 * that claimed losslessness here would be lying.
 *
 * WHY A SAFETY CARVE-OUT. The fields being dropped are exactly where "NEVER
 * call this on a live tree", "refuses unless confirm:true" and similar hard
 * rails live. Dropping prose to save bytes is a cost/benefit call; dropping a
 * rail that prevents a destructive call is not the same kind of call at all, so
 * those sentences are retained regardless of which section they sit in.
 *
 * Domain-free by construction, and therefore here rather than in the host:
 * nothing below knows what a Papercusp tool, workspace or role is.
 */

const UTF8_ENCODER = new TextEncoder();

/**
 * The section labels a composed description is built from.
 *
 * ⚠ THIS IS THE SINGLE SOURCE, DELIBERATELY. `describeFromGuidance()` in
 * `define-tool.ts` COMPOSES with these exact labels and this module SPLITS on
 * them, so the writer and the reader cannot drift into two copies of the same
 * format (derived-truth ladder, rung 1: derive, don't hand-maintain a second
 * copy). If you add a guidance field, add its label here and both sides follow.
 */
export const GUIDANCE_SECTION_LABELS = Object.freeze({
  when: 'When to use:',
  notWhen: 'When NOT to use:',
  chaining: 'Chaining:',
} as const);

/** Separator between composed guidance sections. */
export const GUIDANCE_SECTION_SEPARATOR = '\n\n';

/** Labels in the order `describeFromGuidance` emits them. */
const ORDERED_LABELS: readonly string[] = Object.freeze([
  GUIDANCE_SECTION_LABELS.when,
  GUIDANCE_SECTION_LABELS.notWhen,
  GUIDANCE_SECTION_LABELS.chaining,
]);

/**
 * Markers that make a sentence a HARD RAIL rather than ordinary advice.
 *
 * Two families, kept separate because they fail differently:
 *   - GLYPHS are unambiguous and authored deliberately; a false positive costs
 *     a few retained bytes.
 *   - WORDS are capitalised imperatives. They are matched CASE-SENSITIVELY and
 *     only in all-caps form, because lowercase "never" appears constantly in
 *     ordinary prose ("you never need to pass this") where it is not a rail.
 */
const SAFETY_GLYPHS: readonly string[] = Object.freeze(['⛔', '🚨', '⚠']);
const SAFETY_WORDS: readonly string[] = Object.freeze([
  'NEVER',
  'MUST NOT',
  'DO NOT',
  'REFUSES',
  'REFUSED',
  'IRREVERSIBLE',
  'DESTRUCTIVE',
  'DANGEROUS',
]);

/** Does this sentence carry a hard rail worth keeping at any tier? */
export function isSafetyClause(sentence: string): boolean {
  for (const glyph of SAFETY_GLYPHS) if (sentence.includes(glyph)) return true;
  for (const word of SAFETY_WORDS) if (sentence.includes(word)) return true;
  return false;
}

/**
 * Split prose into sentence-ish units.
 *
 * Deliberately crude and deliberately OVER-inclusive: a unit that is really two
 * sentences costs a few extra retained bytes, whereas a unit split in the
 * middle of a rail could retain "NEVER" while dropping what it forbids. When
 * the two error directions are that asymmetric, bias hard toward the cheap one.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** One parsed section of a composed description. */
interface ParsedSection {
  /** The label, or null for leading prose that preceded any label. */
  label: string | null;
  /** Section text WITHOUT its label prefix. */
  body: string;
}

/**
 * Parse a description into its labelled sections.
 *
 * A description with no recognised label yields a single `label: null` section
 * holding the whole string — which is the correct reading of an explicitly
 * authored `description`, not a parse failure.
 */
function parseSections(description: string): ParsedSection[] {
  const indices: { label: string; at: number }[] = [];
  for (const label of ORDERED_LABELS) {
    const at = description.indexOf(label);
    if (at >= 0) indices.push({ label, at });
  }
  indices.sort((a, b) => a.at - b.at);

  if (indices.length === 0) return [{ label: null, body: description }];

  const sections: ParsedSection[] = [];
  const leading = description.slice(0, indices[0].at).trim();
  if (leading.length > 0) sections.push({ label: null, body: leading });

  for (let i = 0; i < indices.length; i += 1) {
    const start = indices[i].at + indices[i].label.length;
    const end = i + 1 < indices.length ? indices[i + 1].at : description.length;
    sections.push({ label: indices[i].label, body: description.slice(start, end).trim() });
  }
  return sections;
}

/** Is this section kept in full at the partial tier? */
function isKeptWhole(label: string | null): boolean {
  // Leading prose is an authored description's actual content; `when` is the
  // selection signal. Both are what the tier exists to preserve.
  return label === null || label === GUIDANCE_SECTION_LABELS.when;
}

/**
 * Project a description onto its partial form: selection signal + hard rails.
 *
 * Pure and total — it never throws, because it runs on the same measurement and
 * delivery paths as `compactInputSchema`, where one malformed tool must not take
 * down the whole catalog reading. A blank input returns blank.
 */
export function partialGuidanceDescription(description: string | undefined): string {
  if (!description) return '';
  const sections = parseSections(description);
  const out: string[] = [];

  for (const section of sections) {
    if (isKeptWhole(section.label)) {
      const text = section.label ? `${section.label} ${section.body}` : section.body;
      if (text.trim().length > 0) out.push(text.trim());
      continue;
    }
    // A dropped section still surrenders its hard rails.
    const rails = splitSentences(section.body).filter(isSafetyClause);
    if (rails.length > 0) out.push(rails.join(' '));
  }

  return out.join(GUIDANCE_SECTION_SEPARATOR).trim();
}

/**
 * Character ceiling for the SUMMARY tier's lead sentence.
 *
 * ⚠ THIS VALUE IS A MEASUREMENT, NOT A STYLE PREFERENCE — it is the largest
 * tested cap that fits the 100,000 B trimmed-mode budget (D-009). Measured by
 * `SUMMARY_CAP_SWEEP` in `scripts/gen-tool-delivery.ts`, which re-prices the
 * whole catalog and re-resolves the delivery map at each candidate:
 *
 *     2026-09-25, 907-tool catalog before this cap change:
 *     cap=80  full=1 compact=63 spent= 99,977 fits ← chosen
 *     cap=100 full=0 compact=63 spent=100,176 OVER by 176
 *
 * THE TRADE, stated because it is real: pricing prose into the tier costs 8
 * advertised seats (71 → 63). That is the right direction — a tool advertised
 * with an empty description occupies a budget seat while being unidentifiable,
 * which is the 2026-05-21 "Tool X" failure, and the tools that lose a seat stay
 * reachable through `tools:find`. Re-run the sweep after any catalog change
 * before editing this number by hand.
 */
export const SUMMARY_LEAD_MAX_CHARS = 80;

/** Truncate at a word boundary, marking the cut so a reader knows prose is missing. */
function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Project a description onto a SUMMARY: one lead sentence plus every hard rail.
 *
 * WHY THIS EXISTS BESIDE `partialGuidanceDescription`. Partial was specified to
 * drop `notWhen`/`chaining` prose — but MEASURED against the live catalog it
 * saves ~0.8%, because the overwhelming majority of tools declare an EXPLICIT
 * `description` and therefore have no guidance sections to drop at all. A
 * projection that only reduces composed descriptions cannot cut a catalog that
 * is mostly not composed. Summary reduces the prose that actually exists.
 *
 * The ordering is deliberate: RAILS ARE NEVER TRADED FOR THE LEAD. A summary
 * that fits by dropping "this is irreversible" is not a cheaper tier, it is a
 * more dangerous one.
 */
export function summaryGuidanceDescription(
  description: string | undefined,
  maxChars: number = SUMMARY_LEAD_MAX_CHARS,
): string {
  if (!description) return '';
  const sections = parseSections(description);

  // Primary content = the `when` section if composed, else the leading prose.
  const primary =
    sections.find((s) => s.label === GUIDANCE_SECTION_LABELS.when)?.body ??
    sections.find((s) => s.label === null)?.body ??
    '';

  const rails: string[] = [];
  for (const section of sections) {
    for (const sentence of splitSentences(section.body)) {
      if (isSafetyClause(sentence)) rails.push(truncateAtWord(sentence, maxChars));
    }
  }

  const leadSentence = splitSentences(primary)[0] ?? '';
  const lead = truncateAtWord(leadSentence, maxChars);

  // De-duplicate: a lead that is itself a rail must not be emitted twice.
  const out = [lead, ...rails.filter((r) => r !== lead)].filter((s) => s.length > 0);
  return out.join(' ').trim();
}

/** What the partial projection kept and removed, for one tool. */
export interface PartialGuidanceLoss {
  /** UTF-8 bytes of the original description. */
  fullBytes: number;
  /** UTF-8 bytes of the partial projection. */
  partialBytes: number;
  /** `fullBytes - partialBytes` — bytes this projection returns. */
  savedBytes: number;
  /** Labels whose prose was reduced (their rails may still have been kept). */
  reducedSections: string[];
  /** Hard-rail sentences retained OUT of an otherwise-dropped section. */
  retainedSafetyClauses: number;
  /** True when the description carried no recognised guidance label. */
  unlabelled: boolean;
  /** UTF-8 bytes of the SUMMARY projection (lead sentence + hard rails). */
  summaryBytes: number;
}

/**
 * Measure exactly what the partial projection costs one tool.
 *
 * This is the instrument behind the owner's question — "how verbose is the
 * guidance, can it be shortened without losing information?" — and it is
 * deliberately shaped to answer it with a LOSS SET rather than an assurance.
 */
export function partialGuidanceLoss(description: string | undefined): PartialGuidanceLoss {
  const original = description ?? '';
  const partial = partialGuidanceDescription(original);
  const sections = parseSections(original);

  const reducedSections: string[] = [];
  let retainedSafetyClauses = 0;
  for (const section of sections) {
    if (isKeptWhole(section.label)) continue;
    if (section.label) reducedSections.push(section.label);
    retainedSafetyClauses += splitSentences(section.body).filter(isSafetyClause).length;
  }

  const fullBytes = utf8Bytes(original);
  const partialBytes = utf8Bytes(partial);
  return {
    fullBytes,
    partialBytes,
    savedBytes: fullBytes - partialBytes,
    reducedSections,
    retainedSafetyClauses,
    unlabelled: sections.length === 1 && sections[0].label === null,
    summaryBytes: utf8Bytes(summaryGuidanceDescription(original)),
  };
}

/** Exact UTF-8 byte length of a string. */
function utf8Bytes(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

/**
 * What one tool's PROSE costs at each tier, measured as a separate half from
 * its schema (D-006: the policy must be able to trade the two independently).
 */
export interface GuidanceWireBytes {
  /** Description shipped in full. */
  full: number;
  /** Description reduced to selection signal + hard rails. */
  partial: number;
  /** Description dropped entirely — what COMPACT does today. */
  compact: number;
}

/** Measure one tool's description at all three prose tiers. */
export function guidanceWireBytes(description: string | undefined): GuidanceWireBytes {
  return {
    full: utf8Bytes(description ?? ''),
    partial: utf8Bytes(partialGuidanceDescription(description)),
    compact: 0,
  };
}
