/**
 * Measurement tuples — an OBSERVED-measurement duplicate signal for admission
 * screening (plan duplicate-screening-keys-on-authored-prose-and-its-normalize-2026-09-05,
 * P-001; decisions D-001/D-002).
 *
 * Why this exists: every lexical duplicate leg keys on AUTHORED WORDING (title
 * Jaccard, `dedupSignature`), and the normalizer strips numerics outright
 * ('21.6 GiB' -> 'gib'). Two agents who measured the same thing independently
 * write different prose but report the same numbers against the same subjects —
 * EI-22393887492211068 and WI-2145269 (filed 61s apart) share 8 identifier-
 * anchored table sizes, every one within 9.5%, at a title Jaccard of ~0.25.
 *
 * The signal: extract `(anchor, bytes)` tuples, where the anchor is the nearest
 * preceding code-ish identifier on the same line (`session_archive_files 21.6 GiB`).
 * Two texts MATCH when they share anchored measurements on at least TWO DISTINCT
 * anchors within a relative tolerance. Bare numbers never count: "5 GB" alone is
 * shared by half the corpus (R-3).
 *
 * Pure and total: no I/O, never throws on string input, linear in input size
 * (R-5). Byte units only; other unit families are out of scope for this plan.
 */

export interface Measurement {
  /** Normalized (lowercased, edge-punctuation-stripped) identifier the quantity describes. */
  anchor: string;
  /** Quantity converted to bytes (SI for KB/MB/GB/TB, binary for KiB/MiB/GiB/TiB). */
  bytes: number;
  /** The quantity exactly as written, e.g. `21.6 GiB` / `22GB`. */
  raw: string;
}

export interface SharedMeasurement {
  anchor: string;
  a: Measurement;
  b: Measurement;
  /** |a - b| / min(a, b) — the stricter of the two relative-difference conventions. */
  relDiff: number;
}

export interface MeasurementOverlap {
  /** One-to-one matched pairs (a measurement is used at most once per side). */
  pairs: SharedMeasurement[];
  /** Distinct anchors among `pairs`, sorted. This — not `pairs.length` — gates a match. */
  anchors: string[];
  match: boolean;
}

export interface MeasurementMatchOptions {
  /** Relative tolerance after byte conversion. Default 0.10 (plan Design). */
  tolerance?: number;
  /** Distinct shared anchors required for a match. Default 2 (R-3). */
  minSharedAnchors?: number;
}

export const DEFAULT_MEASUREMENT_TOLERANCE = 0.1;
export const DEFAULT_MIN_SHARED_ANCHORS = 2;
/** How many whitespace tokens back from a quantity an anchor may sit. */
export const ANCHOR_TOKEN_WINDOW = 6;
/** Bound on tuples extracted per text, so matching stays cheap on hostile input. */
export const MAX_MEASUREMENTS_PER_TEXT = 500;

const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 2 ** 10,
  mib: 2 ** 20,
  gib: 2 ** 30,
  tib: 2 ** 40,
};

/**
 * A number, optional single space, a byte unit. The lookbehind keeps it from
 * starting mid-token (`v1.2GB`, `x3GB`); the trailing lookahead rejects `GBit`
 * style continuations while still allowing `5.6GB/8M` and `1.3 GiB/min`.
 */
const QUANTITY_RE = /(?<![\w.])(\d+(?:\.\d+)?) ?(kib|mib|gib|tib|kb|mb|gb|tb|b)(?![a-z0-9_])/gi;

const LEADING_PUNCT_RE = /^[([{'"`<*~/]+/;
const TRAILING_PUNCT_RE = /[)\]}'"`>,;:.!?*]+$/;
/** Starts with a letter, identifier-ish body, and contains at least one of `_ . / -`. */
const CODEISH_RE = /^[a-z][a-z0-9_./-]*$/;
const CODEISH_SEPARATOR_RE = /[_./-]/;

function normalizeAnchor(token: string): string | null {
  const t = token.toLowerCase().replace(LEADING_PUNCT_RE, '').replace(TRAILING_PUNCT_RE, '');
  if (t.length < 3) return null;
  if (!CODEISH_RE.test(t) || !CODEISH_SEPARATOR_RE.test(t)) return null;
  return t;
}

/** Nearest code-ish token (scanning backwards) within the window, or null. */
function findAnchor(region: string): string | null {
  const tokens = region.split(/\s+/).filter(Boolean);
  const stop = Math.max(0, tokens.length - ANCHOR_TOKEN_WINDOW);
  for (let i = tokens.length - 1; i >= stop; i--) {
    const anchor = normalizeAnchor(tokens[i]);
    if (anchor) return anchor;
  }
  return null;
}

/**
 * Extract identifier-anchored byte measurements. Quantities with no anchor are
 * dropped (they can never support a match). The anchor search for a quantity is
 * confined to its own line and to the text AFTER the previous quantity on that
 * line, so `tool_invocations 15 GB <-- WI-844 recorded 5.6 GB` anchors 5.6 GB to
 * `wi-844`, never to `tool_invocations`.
 */
export function extractMeasurements(text: string): Measurement[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: Measurement[] = [];
  try {
    for (const line of text.split('\n')) {
      if (out.length >= MAX_MEASUREMENTS_PER_TEXT) break;
      let regionStart = 0;
      QUANTITY_RE.lastIndex = 0;
      for (let m = QUANTITY_RE.exec(line); m; m = QUANTITY_RE.exec(line)) {
        const value = Number.parseFloat(m[1]);
        const unit = UNIT_BYTES[m[2].toLowerCase()];
        const anchor = findAnchor(line.slice(regionStart, m.index));
        regionStart = m.index + m[0].length;
        if (!anchor || !Number.isFinite(value) || value <= 0 || unit === undefined) continue;
        out.push({ anchor, bytes: value * unit, raw: m[0] });
        if (out.length >= MAX_MEASUREMENTS_PER_TEXT) break;
      }
    }
  } catch {
    // Total by contract (R-5): an extraction fault yields no signal, never a failed create.
    return [];
  }
  return out;
}

function relativeDiff(x: number, y: number): number {
  const lo = Math.min(x, y);
  return lo > 0 ? Math.abs(x - y) / lo : Number.POSITIVE_INFINITY;
}

function toMeasurements(input: string | readonly Measurement[]): readonly Measurement[] {
  return typeof input === 'string' ? extractMeasurements(input) : input;
}

/**
 * Anchor-equal measurement pairs within `tolerance`, matched one-to-one: each
 * measurement on either side is used at most once, taking the closest partner
 * first. A text that repeats a measurement (title AND summary) can therefore
 * contribute that anchor more than once, but only against as many repeats on
 * the other side.
 */
export function sharedMeasurements(
  a: string | readonly Measurement[],
  b: string | readonly Measurement[],
  opts: Pick<MeasurementMatchOptions, 'tolerance'> = {},
): SharedMeasurement[] {
  const tolerance = opts.tolerance ?? DEFAULT_MEASUREMENT_TOLERANCE;
  const left = toMeasurements(a);
  const right = toMeasurements(b);
  if (left.length === 0 || right.length === 0) return [];

  const rightByAnchor = new Map<string, Measurement[]>();
  for (const m of right) {
    const bucket = rightByAnchor.get(m.anchor);
    if (bucket) bucket.push(m);
    else rightByAnchor.set(m.anchor, [m]);
  }

  // Candidate edges per anchor, closest first, then greedy one-to-one.
  const edges: SharedMeasurement[] = [];
  for (const la of left) {
    const bucket = rightByAnchor.get(la.anchor);
    if (!bucket) continue;
    for (const rb of bucket) {
      const relDiff = relativeDiff(la.bytes, rb.bytes);
      if (relDiff <= tolerance) edges.push({ anchor: la.anchor, a: la, b: rb, relDiff });
    }
  }
  edges.sort((x, y) => x.relDiff - y.relDiff);
  const usedA = new Set<Measurement>();
  const usedB = new Set<Measurement>();
  const pairs: SharedMeasurement[] = [];
  for (const e of edges) {
    if (usedA.has(e.a) || usedB.has(e.b)) continue;
    usedA.add(e.a);
    usedB.add(e.b);
    pairs.push(e);
  }
  return pairs;
}

export function measurementOverlap(
  a: string | readonly Measurement[],
  b: string | readonly Measurement[],
  opts: MeasurementMatchOptions = {},
): MeasurementOverlap {
  const pairs = sharedMeasurements(a, b, opts);
  const anchors = [...new Set(pairs.map((p) => p.anchor))].sort();
  const minShared = opts.minSharedAnchors ?? DEFAULT_MIN_SHARED_ANCHORS;
  return { pairs, anchors, match: anchors.length >= minShared };
}

/** True when the texts share anchored measurements on >= 2 distinct anchors (R-3). */
export function measurementsMatch(
  a: string | readonly Measurement[],
  b: string | readonly Measurement[],
  opts: MeasurementMatchOptions = {},
): boolean {
  return measurementOverlap(a, b, opts).match;
}
