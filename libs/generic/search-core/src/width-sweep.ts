/**
 * The width sweep: how much retrieval does cutting a row to its first W
 * characters before embedding cost, and at what width does the gain stop?
 *
 * Moved from papercusp's turn-truncation-width instrument (the P-028(b)
 * measurement of `left(text, 2000)`), which measured one table through one
 * sidecar. Here the corpus and the embedder are injected, so the same sweep
 * answers the question for any collection and any model.
 *
 * ─── THE METHOD ──────────────────────────────────────────
 * Each usable document contributes one probe: a window of its own text cut at
 * `probeStart`, embedded as a query. For every width W the documents are
 * embedded on their first W characters, and each probe is scored by the rank of
 * its true parent among every document in the sample (a sample of 60 is 59
 * distractors). RANK-based, never cosine-based: an asymmetric model can put a
 * large positive offset on unrelated pairs, so an absolute similarity means
 * nothing; only whether the true parent outranks the distractors does.
 *
 * `probeStart` is the control. With one fixed offset, "width W scored best" can
 * be an artifact of W being the first width that CONTAINS the probe; re-running
 * at a different offset separates "wider is better" from "the probe arrived".
 * `identicalToFirst` counts documents whose vector did not change from the
 * first width, which shows where the model's own input window cuts in.
 *
 * An optional chunked arm scores each document by its best chunk, so the sweep
 * can compare widening the cut against splitting the row.
 */
import {
  type BenchEmbed,
  type RankSummary,
  cosine,
  isDistinctiveProbe,
  rankKeys,
  summarizeRankings,
} from './retrieval-bench';

export interface WidthSweepDoc {
  key: string;
  text: string;
}

export interface WidthSweepChunkArm {
  /** Row label for the arm, for example `chunk1800`. */
  label: string;
  /** Split one document into the chunks that are embedded for it. */
  split: (text: string) => string[];
}

export interface WidthSweepInput {
  /** Candidate documents, most preferred first. The first `sample` usable ones take part. */
  docs: readonly WidthSweepDoc[];
  /** Embed-prefix widths in characters, in reporting order. The first is the identicalToFirst baseline. */
  widths: readonly number[];
  /** Character offset each probe is cut from. */
  probeStart: number;
  /** Probe length in characters. Default 240. */
  probeLength?: number;
  /** At most this many documents take part. */
  sample: number;
  /** Refuse to report on fewer usable documents than this. Default 10. */
  minDocs?: number;
  embed: BenchEmbed;
  chunkArm?: WidthSweepChunkArm;
}

export interface WidthSweepArm extends RankSummary {
  label: string;
  /** The width measured, or null for the chunked arm. */
  width: number | null;
  /** Width arms: documents whose vector is identical (cosine > 0.9999) to the first width's. */
  identicalToFirst: number | null;
  /** Chunked arm: mean chunks per document. */
  meanChunks: number | null;
}

export interface WidthSweepResult {
  /** The documents that took part, in order. Document i is the true parent of probe i. */
  docs: WidthSweepDoc[];
  probes: string[];
  /** One arm per width in `widths` order, then the chunked arm when requested. */
  arms: WidthSweepArm[];
}

const DEFAULT_PROBE_LENGTH = 240;
const DEFAULT_MIN_DOCS = 10;
const IDENTICAL_COSINE = 0.9999;

/** Rank every probe's true parent under one arm's similarity. */
function scoreArm(n: number, sim: (probeIdx: number, docIdx: number) => number): RankSummary {
  const keys = Array.from({ length: n }, (_, j) => String(j));
  const ranked = keys.map((target, i) =>
    rankKeys(
      keys,
      keys.map((_, j) => sim(i, j)),
      target,
    ),
  );
  const { n: count, mrr, recallAt1, recallAt5, meanRank } = summarizeRankings(ranked, keys);
  return { n: count, mrr, recallAt1, recallAt5, meanRank };
}

export async function runWidthSweep(input: WidthSweepInput): Promise<WidthSweepResult> {
  const probeLength = input.probeLength ?? DEFAULT_PROBE_LENGTH;
  const minDocs = input.minDocs ?? DEFAULT_MIN_DOCS;
  const { probeStart } = input;

  const docs: WidthSweepDoc[] = [];
  for (const d of input.docs) {
    if (docs.length >= input.sample) break;
    if (d.text.length < probeStart + probeLength) continue;
    if (isDistinctiveProbe(d.text.slice(probeStart, probeStart + probeLength))) docs.push(d);
  }
  if (docs.length < minDocs) throw new Error(`only ${docs.length} usable documents — sample too small`);

  const probes = docs.map((d) => d.text.slice(probeStart, probeStart + probeLength));
  const qvecs = await input.embed('query', probes);

  const arms: WidthSweepArm[] = [];
  let baseline: number[][] = [];
  for (const w of input.widths) {
    const dvecs = await input.embed(
      'document',
      docs.map((d) => d.text.slice(0, w)),
    );
    if (baseline.length === 0) baseline = dvecs;
    const identical = dvecs.filter((v, j) => cosine(v, baseline[j]) > IDENTICAL_COSINE).length;
    arms.push({
      label: String(w),
      width: w,
      ...scoreArm(probes.length, (i, j) => cosine(qvecs[i], dvecs[j])),
      identicalToFirst: identical,
      meanChunks: null,
    });
  }

  if (input.chunkArm) {
    const chunksPerDoc = docs.map((d) => input.chunkArm!.split(d.text));
    const flat = chunksPerDoc.flat();
    const flatVecs = await input.embed('document', flat);
    const chunkVecs: number[][][] = [];
    let off = 0;
    for (const cs of chunksPerDoc) {
      chunkVecs.push(flatVecs.slice(off, off + cs.length));
      off += cs.length;
    }
    arms.push({
      label: input.chunkArm.label,
      width: null,
      ...scoreArm(probes.length, (i, j) => Math.max(...chunkVecs[j].map((cv) => cosine(qvecs[i], cv)))),
      identicalToFirst: null,
      meanChunks: flat.length / docs.length,
    });
  }

  return { docs, probes, arms };
}
