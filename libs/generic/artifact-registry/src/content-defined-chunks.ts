/**
 * Content-defined chunking (FastCDC-style, gear rolling hash, normalized chunking).
 *
 * Splits bytes at positions chosen by the CONTENT rather than by fixed offsets,
 * so an insertion or edit only changes the chunks around it: two byte strings
 * that share a long run produce identical chunks over that run, and a
 * content-addressed store keyed by chunk hash stores the shared part once.
 *
 * The cut test reads the top bits of a 32-bit gear hash, which depend only on
 * the last 32 bytes. Normalized chunking uses a stricter mask before the target
 * average and a looser one after it, which narrows the size distribution.
 *
 * The gear table is generated from a fixed seed, so boundaries are stable across
 * processes, runtimes and releases. Changing the seed or the masks does not break
 * correctness (each chunk is still addressed by its own hash), but it changes
 * every boundary, so stores keyed by chunk hash stop deduplicating against chunks
 * written by the old version. The golden test pins this.
 *
 * Runtime-neutral: plain Uint8Array arithmetic, no Node or Web APIs.
 */

export interface ContentDefinedChunkOptions {
  /** Target average chunk size in bytes. Must be a power of two in [256, 2^24]. Default 8192. */
  readonly avgSize?: number;
  /** Smallest chunk except the last. Default avgSize / 4. */
  readonly minSize?: number;
  /** Largest chunk. Default avgSize * 8. */
  readonly maxSize?: number;
}

export const DEFAULT_CDC_AVG_SIZE = 8192;

const GEAR: Uint32Array = (() => {
  // splitmix32 from a fixed seed: deterministic and dependency-free.
  const table = new Uint32Array(256);
  let state = 0x9e3779b9;
  for (let i = 0; i < 256; i++) {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    table[i] = (z ^ (z >>> 16)) >>> 0;
  }
  return table;
})();

function topBitsMask(bits: number): number {
  if (bits <= 0) return 0;
  if (bits >= 32) return 0xffffffff;
  return (0xffffffff << (32 - bits)) >>> 0;
}

interface ResolvedChunkSizes {
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly maskStrict: number;
  readonly maskLoose: number;
}

function resolveSizes(options: ContentDefinedChunkOptions): ResolvedChunkSizes {
  const avg = options.avgSize ?? DEFAULT_CDC_AVG_SIZE;
  if (!Number.isInteger(avg) || avg < 256 || avg > 1 << 24 || (avg & (avg - 1)) !== 0) {
    throw new RangeError(`content-defined chunks: avgSize must be a power of two in [256, 2^24], got ${avg}`);
  }
  const min = options.minSize ?? avg / 4;
  const max = options.maxSize ?? avg * 8;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > avg || max < avg) {
    throw new RangeError(
      `content-defined chunks: need integer 1 <= minSize <= avgSize <= maxSize, got min=${min} avg=${avg} max=${max}`,
    );
  }
  const bits = Math.log2(avg);
  return { avg, min, max, maskStrict: topBitsMask(bits + 2), maskLoose: topBitsMask(bits - 2) };
}

function nextCut(bytes: Uint8Array, start: number, sizes: ResolvedChunkSizes): number {
  const remaining = bytes.length - start;
  if (remaining <= sizes.min) return bytes.length;
  const end = start + Math.min(remaining, sizes.max);
  const normal = start + Math.min(remaining, sizes.avg);
  let hash = 0;
  let i = start + sizes.min;
  for (; i < normal; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
    if ((hash & sizes.maskStrict) === 0) return i + 1;
  }
  for (; i < end; i++) {
    hash = ((hash << 1) + GEAR[bytes[i]!]!) >>> 0;
    if ((hash & sizes.maskLoose) === 0) return i + 1;
  }
  return end;
}

/**
 * End offsets (exclusive) of each chunk, in order. The last offset equals
 * `bytes.length`; an empty input yields no chunks.
 */
export function contentDefinedChunkBoundaries(
  bytes: Uint8Array,
  options: ContentDefinedChunkOptions = {},
): number[] {
  const sizes = resolveSizes(options);
  const ends: number[] = [];
  for (let start = 0; start < bytes.length; ) {
    const cut = nextCut(bytes, start, sizes);
    ends.push(cut);
    start = cut;
  }
  return ends;
}

/** The chunks themselves, as zero-copy views into `bytes`. */
export function contentDefinedChunks(bytes: Uint8Array, options: ContentDefinedChunkOptions = {}): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const end of contentDefinedChunkBoundaries(bytes, options)) {
    chunks.push(bytes.subarray(start, end));
    start = end;
  }
  return chunks;
}
