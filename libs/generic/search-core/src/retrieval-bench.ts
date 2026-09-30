/**
 * The chunking retrieval bench — does splitting long rows into separately
 * embedded chunks make text past an embedder's input window findable, and what
 * does it cost the rows that were never chunked?
 *
 * Generalized from papercusp's turn-truncation instrument (its plan D-016),
 * which measured one collection with one splitter. Here the corpus, the
 * splitters and the embedder are all injected, so one harness answers the
 * question for any collection in any host.
 *
 * ─── THE METHOD ─────────────────────────────────────────────────────────────
 * RANK-based, never cosine-based. Under an asymmetric embedder unrelated pairs
 * can carry a large positive cosine offset, so an absolute similarity is
 * uninterpretable; the only sound measure is whether the true parent OUTRANKS
 * the distractors in its pool. Each probe is a window of real text, embedded
 * as a query, and scored by the rank of its true parent among every row in its
 * fold (a fold of 60 rows is 59 distractors).
 *
 * Two probe classes, because chunking can fail in two directions:
 *   - `tail`  a window drawn from PAST the parent's window: text the parent
 *             vector never saw. The gain chunking is for.
 *   - `short` a window of a row too short to be chunked. Best-match pooling
 *             gives every long row one extra chance per chunk to outscore it,
 *             so this class measures whether short rows get demoted. Pooling
 *             can only raise a long row's score and never a short row's, so a
 *             short probe's rank can only stay or worsen; the question is how
 *             often it worsens.
 *
 * Arms: `parent` scores a row by its parent vector alone (the status quo, and
 * gist mode). `<splitter>@<k>` scores it by the best of its parent vector and
 * its first k chunk vectors (retrieve mode); `<splitter>@<k>-m<δ>` subtracts a
 * margin δ from every chunk similarity first, so a chunk displaces a row only
 * when it beats that row by more than δ. Every splitter is embedded once at
 * the largest k in the sweep and smaller caps are scored as PREFIXES, which is
 * sound only because a splitter's cap truncates its output (the contract on
 * {@link BenchSplitter}).
 *
 * Pure apart from the injected embedder: no store, no SQL, no model.
 */

import { recallAtK } from './relevance-eval';

/** Which side of an asymmetric embedder a text is embedded on. */
export type BenchEmbedKind = 'document' | 'query';

/**
 * Embed texts, returning one vector per text in input order. Use the same
 * model, kinds and text recipe production writes with; a bench that embeds
 * differently measures a different space.
 */
export type BenchEmbed = (kind: BenchEmbedKind, texts: readonly string[]) => Promise<number[][]>;

/** One row of the collection under test. */
export interface BenchRow {
  /** Unique within the corpus; how a probe names its true parent. */
  key: string;
  /** The full, uncut text a chunk store would split. */
  text: string;
  /** Prefixed to every chunk as `header\nchunk`, the way a chunk store embeds it. */
  header?: string;
  /**
   * The exact text the parent vector embeds in production (its window already
   * applied). A tail probe must not occur in it, and the `parent` arm embeds it.
   */
  parentDoc: string;
}

/**
 * Split a row into chunk bodies (without the header).
 *
 * CONTRACT: the cap truncates. `split(row, k)` must equal the first k entries of
 * `split(row, K)` for every k < K, because the bench embeds once at the largest
 * cap and scores smaller caps as prefixes.
 */
export type BenchSplitter = (row: BenchRow, maxChunks: number) => string[];

export type ProbeClass = 'tail' | 'short';

export interface BenchProbe {
  /** Key of the true parent row. */
  key: string;
  text: string;
  probeClass: ProbeClass;
  /** Offset of the probe in its row's `text`. */
  start: number;
}

/** One independent pool: every probe's true parent must be among `rows`. */
export interface BenchFold {
  rows: BenchRow[];
  probes: BenchProbe[];
}

export interface ChunkingBenchInput {
  folds: BenchFold[];
  /** Named splitters to compare. */
  splitters: Record<string, BenchSplitter>;
  /** Chunk caps to score, e.g. [8, 16, 32]. */
  maxChunks: number[];
  /**
   * Margins subtracted from chunk similarities before pooling. Default [0]
   * (plain best-match). Every cap is scored at every margin.
   */
  chunkMargins?: number[];
  /**
   * Rows whose `text` is at or under this length get no chunks: it is the
   * parent vector's window, so their parent vector already saw all of them.
   */
  minChunkTextChars: number;
  embed: BenchEmbed;
}

/** Rank statistics over one probe class. Every metric is null when n is 0. */
export interface RankSummary {
  n: number;
  mrr: number | null;
  recallAt1: number | null;
  recallAt5: number | null;
  meanRank: number | null;
}

export interface ArmClassResult extends RankSummary {
  /** Probes ranked better / worse / the same than under the `parent` arm. */
  improved: number;
  worsened: number;
  unchanged: number;
  /**
   * Tail class only: the share of probes whose text lies wholly inside one of
   * the row's scored chunks. A probe past the last chunk (the cap) or split
   * across a boundary cannot be matched verbatim, so this bounds what the arm
   * can reach. Null for the `parent` arm and the `short` class.
   */
  containedRate: number | null;
}

export interface ArmResult {
  label: string;
  /** Null for the `parent` arm. */
  splitter: string | null;
  maxChunks: number | null;
  chunkMargin: number | null;
  tail: ArmClassResult;
  short: ArmClassResult;
}

export interface SplitterStats {
  /** Rows that were chunked (text longer than minChunkTextChars). */
  chunkedRows: number;
  /** Mean chunks per chunked row at the largest cap. */
  meanChunks: number;
  /** Per cap: chunked rows whose split filled the cap, so text past it went unindexed. */
  rowsAtCap: Record<number, number>;
}

export interface ChunkingBenchResult {
  folds: number;
  poolSizes: number[];
  /** Probes dropped because their text also occurs in another row of their fold. */
  ambiguousProbesDropped: number;
  splitters: Record<string, SplitterStats>;
  arms: ArmResult[];
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/**
 * A probe is a fair test only if it is distinctive prose. A window of
 * punctuation, a table rule or a base64 blob is unretrievable by every arm and
 * would depress them all equally: noise, not signal.
 */
export function isDistinctiveProbe(text: string): boolean {
  if (text.length === 0) return false;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  return letters / text.length > 0.5 && text.trim().split(/\s+/).length >= 15;
}

/** FNV-1a, 32-bit. Seeds probe placement so a re-run draws the same probes. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface TailProbeOptions {
  /** Where the parent's window ends; the probe starts at or after it. */
  cut: number;
  /** Probe length in characters. */
  length: number;
  /**
   * Fixed offset instead of a seeded one. The control for a fixed-offset
   * artifact: a result that holds at two offsets is not about where the probe
   * happened to land.
   */
  at?: number;
  /** Seeded offsets tried before giving up. Default 8. */
  attempts?: number;
}

/**
 * Draw a probe from text the parent vector never saw. Offsets are seeded by the
 * row key, spread over the whole tail, and each candidate must be distinctive
 * and absent from `parentDoc`. Null when no candidate qualifies.
 */
export function drawTailProbe(row: BenchRow, opts: TailProbeOptions): BenchProbe | null {
  const { cut, length, at, attempts = 8 } = opts;
  const span = row.text.length - length - cut;
  if (span < 0) return null;
  const starts: number[] = [];
  if (at !== undefined) {
    if (at >= cut && at + length <= row.text.length) starts.push(at);
  } else {
    const h = fnv1a(row.key);
    for (let a = 0; a < attempts; a++) {
      starts.push(cut + (((h + Math.imul(a, 0x9e3779b1)) >>> 0) % (span + 1)));
    }
  }
  for (const start of starts) {
    const text = row.text.slice(start, start + length);
    if (isDistinctiveProbe(text) && !row.parentDoc.includes(text)) {
      return { key: row.key, text, probeClass: 'tail', start };
    }
  }
  return null;
}

/**
 * Draw a probe from the middle of a row the parent vector sees whole. Null when
 * the row is shorter than the probe, the window is not distinctive, or the
 * parent document does not contain it.
 */
export function drawShortProbe(row: BenchRow, length: number): BenchProbe | null {
  if (row.text.length < length) return null;
  const start = Math.floor((row.text.length - length) / 2);
  const text = row.text.slice(start, start + length);
  if (!isDistinctiveProbe(text) || !row.parentDoc.includes(text)) return null;
  return { key: row.key, text, probeClass: 'short', start };
}

/**
 * Keys of a pool ranked best-first by score, with ties resolved AGAINST the
 * target: a row tied with the true parent is placed above it. A tie is not a
 * win, and an optimistic rule would let duplicated text score as a hit.
 */
export function rankKeys(keys: readonly string[], scores: readonly number[], target: string): string[] {
  return keys
    .map((key, i) => ({ key, s: scores[i] }))
    .sort((a, b) => b.s - a.s || (a.key === target ? 1 : 0) - (b.key === target ? 1 : 0))
    .map((x) => x.key);
}

/** Summarize one probe class. `ranked[i]` is probe i's ranking, `targets[i]` its true key. */
export function summarizeRankings(
  ranked: ReadonlyArray<readonly string[]>,
  targets: readonly string[],
): RankSummary & { ranks: number[] } {
  const n = ranked.length;
  const ranks = ranked.map((r, i) => r.indexOf(targets[i]) + 1);
  if (n === 0) return { n, mrr: null, recallAt1: null, recallAt5: null, meanRank: null, ranks };
  let rr = 0;
  let r1 = 0;
  let r5 = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    rr += 1 / ranks[i];
    sum += ranks[i];
    r1 += recallAtK(ranked[i], [targets[i]], 1) ?? 0;
    r5 += recallAtK(ranked[i], [targets[i]], 5) ?? 0;
  }
  return { n, mrr: rr / n, recallAt1: r1 / n, recallAt5: r5 / n, meanRank: sum / n, ranks };
}

/**
 * A row's best similarity to a query over its parent vector and its first k
 * chunks, each chunk similarity lowered by `margin` first.
 */
export function pooledScore(
  query: readonly number[],
  parent: readonly number[],
  chunks: ReadonlyArray<readonly number[]>,
  maxChunks: number,
  margin = 0,
): number {
  let best = cosine(query, parent);
  const k = Math.min(maxChunks, chunks.length);
  for (let i = 0; i < k; i++) best = Math.max(best, cosine(query, chunks[i]) - margin);
  return best;
}

interface ArmSpec {
  label: string;
  splitter: string | null;
  maxChunks: number | null;
  chunkMargin: number | null;
}

/**
 * One fold, embedded and reduced to similarities. Every arm is a different
 * reading of the same probe × row and probe × row × chunk cosines, so they are
 * computed once here and never per arm.
 */
interface FoldVectors {
  keys: string[];
  /** splitter → row index → chunk bodies (empty for unchunked rows). */
  chunkText: Record<string, string[][]>;
  probes: BenchProbe[];
  /** probe index → row index → cosine to the row's parent vector. */
  parentSim: number[][];
  /** splitter → probe index → row index → cosine to each chunk, in chunk order. */
  chunkSim: Record<string, number[][][]>;
}

function chunkDoc(row: BenchRow, chunk: string): string {
  return row.header ? `${row.header}\n${chunk}` : chunk;
}

async function vectorizeFold(
  fold: BenchFold,
  input: ChunkingBenchInput,
  maxCap: number,
): Promise<{ vectors: FoldVectors; ambiguous: number }> {
  const { rows } = fold;
  // A probe whose text also occurs in another row has two true parents; ranking
  // one of them "wrong" would be the pool's fault, not the arm's.
  const probes = fold.probes.filter((p) => !rows.some((r) => r.key !== p.key && r.text.includes(p.text)));
  const ambiguous = fold.probes.length - probes.length;

  const probeVecs = probes.length > 0 ? await input.embed('query', probes.map((p) => p.text)) : [];
  const parent = await input.embed('document', rows.map((r) => r.parentDoc));
  const parentSim = probeVecs.map((q) => parent.map((d) => cosine(q, d)));
  const chunkText: Record<string, string[][]> = {};
  const chunkSim: Record<string, number[][][]> = {};
  for (const [name, split] of Object.entries(input.splitters)) {
    const perRow = rows.map((r) => (r.text.length > input.minChunkTextChars ? split(r, maxCap) : []));
    const flatDocs = perRow.flatMap((cs, i) => cs.map((c) => chunkDoc(rows[i], c)));
    const flat = flatDocs.length > 0 ? await input.embed('document', flatDocs) : [];
    const vecs: number[][][] = [];
    let off = 0;
    for (const cs of perRow) {
      vecs.push(flat.slice(off, off + cs.length));
      off += cs.length;
    }
    chunkText[name] = perRow;
    chunkSim[name] = probeVecs.map((q) => vecs.map((cv) => cv.map((c) => cosine(q, c))));
  }
  return { vectors: { keys: rows.map((r) => r.key), chunkText, probes, parentSim, chunkSim }, ambiguous };
}

function rankFold(v: FoldVectors, arm: ArmSpec): { rankings: string[][]; contained: boolean[] } {
  const rankings: string[][] = [];
  const contained: boolean[] = [];
  const k = arm.maxChunks ?? 0;
  const margin = arm.chunkMargin ?? 0;
  v.probes.forEach((probe, pi) => {
    // The same arithmetic as pooledScore, over the cached similarities.
    const scores = v.keys.map((_, ri) => {
      let best = v.parentSim[pi][ri];
      if (arm.splitter !== null) {
        const sims = v.chunkSim[arm.splitter][pi][ri];
        for (let c = 0; c < Math.min(k, sims.length); c++) best = Math.max(best, sims[c] - margin);
      }
      return best;
    });
    rankings.push(rankKeys(v.keys, scores, probe.key));
    if (arm.splitter !== null) {
      const ri = v.keys.indexOf(probe.key);
      contained.push(
        v.chunkText[arm.splitter][ri].slice(0, arm.maxChunks ?? 0).some((c) => c.includes(probe.text)),
      );
    }
  });
  return { rankings, contained };
}

/**
 * Run every arm over every fold. Ranks are computed within a fold; summaries
 * pool the probes of all folds.
 */
export async function runChunkingBench(input: ChunkingBenchInput): Promise<ChunkingBenchResult> {
  const caps = [...new Set(input.maxChunks)].filter((k) => k > 0).sort((a, b) => a - b);
  if (caps.length === 0) throw new Error('runChunkingBench: maxChunks needs at least one positive cap');
  const maxCap = caps[caps.length - 1];
  const margins = [...new Set(input.chunkMargins ?? [0])].sort((a, b) => a - b);
  const splitterNames = Object.keys(input.splitters);
  const arms: ArmSpec[] = [
    { label: 'parent', splitter: null, maxChunks: null, chunkMargin: null },
    ...splitterNames.flatMap((s) =>
      caps.flatMap((k) =>
        margins.map((m) => ({ label: m === 0 ? `${s}@${k}` : `${s}@${k}-m${m}`, splitter: s, maxChunks: k, chunkMargin: m })),
      ),
    ),
  ];

  const vectorized: FoldVectors[] = [];
  let ambiguousProbesDropped = 0;
  for (const fold of input.folds) {
    const { vectors, ambiguous } = await vectorizeFold(fold, input, maxCap);
    vectorized.push(vectors);
    ambiguousProbesDropped += ambiguous;
  }

  const splitters: Record<string, SplitterStats> = {};
  for (const s of splitterNames) {
    const counts = vectorized.flatMap((v) => v.chunkText[s].filter((cs) => cs.length > 0).map((cs) => cs.length));
    const rowsAtCap: Record<number, number> = {};
    for (const k of caps) rowsAtCap[k] = counts.filter((c) => c >= k).length;
    splitters[s] = {
      chunkedRows: counts.length,
      meanChunks: counts.length === 0 ? 0 : counts.reduce((a, b) => a + b, 0) / counts.length,
      rowsAtCap,
    };
  }

  // Per arm, per class: every probe's rank (in fold order) and containment.
  const perArm = arms.map((arm) => {
    const byClass: Record<ProbeClass, { rankings: string[][]; targets: string[]; contained: boolean[] }> = {
      tail: { rankings: [], targets: [], contained: [] },
      short: { rankings: [], targets: [], contained: [] },
    };
    for (const v of vectorized) {
      const { rankings, contained } = rankFold(v, arm);
      v.probes.forEach((p, i) => {
        byClass[p.probeClass].rankings.push(rankings[i]);
        byClass[p.probeClass].targets.push(p.key);
        if (arm.splitter !== null) byClass[p.probeClass].contained.push(contained[i]);
      });
    }
    return { arm, byClass };
  });

  const baseline = perArm[0];
  const baseRanks: Record<ProbeClass, number[]> = {
    tail: summarizeRankings(baseline.byClass.tail.rankings, baseline.byClass.tail.targets).ranks,
    short: summarizeRankings(baseline.byClass.short.rankings, baseline.byClass.short.targets).ranks,
  };

  const classResult = (
    arm: ArmSpec,
    cls: ProbeClass,
    data: { rankings: string[][]; targets: string[]; contained: boolean[] },
  ): ArmClassResult => {
    const { ranks, ...summary } = summarizeRankings(data.rankings, data.targets);
    let improved = 0;
    let worsened = 0;
    ranks.forEach((r, i) => {
      if (r < baseRanks[cls][i]) improved++;
      else if (r > baseRanks[cls][i]) worsened++;
    });
    const containedRate =
      arm.splitter === null || cls !== 'tail' || data.contained.length === 0
        ? null
        : data.contained.filter(Boolean).length / data.contained.length;
    return { ...summary, improved, worsened, unchanged: ranks.length - improved - worsened, containedRate };
  };

  return {
    folds: input.folds.length,
    poolSizes: input.folds.map((f) => f.rows.length),
    ambiguousProbesDropped,
    splitters,
    arms: perArm.map(({ arm, byClass }) => ({
      label: arm.label,
      splitter: arm.splitter,
      maxChunks: arm.maxChunks,
      chunkMargin: arm.chunkMargin,
      tail: classResult(arm, 'tail', byClass.tail),
      short: classResult(arm, 'short', byClass.short),
    })),
  };
}

/** The pre-declared rule that turns a bench result into a register-or-not call. */
export interface ChunkingDecisionRule {
  /** Fewer tail probes than this and there is no verdict. */
  minTailProbes: number;
  /** Fewer short probes than this and short-row demotion cannot be judged. */
  minShortProbes: number;
  /** Tail MRR an arm must add over `parent` to be worth a store. */
  minTailMrrGain: number;
  /** Short-row MRR an arm may lose against `parent` and still qualify. */
  maxShortMrrDrop: number;
  /**
   * Arms whose tail MRR is within this of the best are treated as equal, and
   * the one with the fewest chunks wins: more chunks cost embeddings and storage
   * for a gain the sample cannot resolve.
   */
  mrrTolerance: number;
}

export interface ChunkingDecision {
  verdict: 'register' | 'skip' | 'insufficient-sample';
  /** The chosen arm when the verdict is `register`. */
  arm: ArmResult | null;
  reasons: string[];
}

/**
 * Apply a {@link ChunkingDecisionRule}. Qualifying arms are those within the
 * short-row budget; among them the best tail MRR wins, ties (within
 * `mrrTolerance`) going to the smaller cap, then the smaller margin, then
 * splitter order.
 */
export function decideChunking(result: ChunkingBenchResult, rule: ChunkingDecisionRule): ChunkingDecision {
  const parent = result.arms.find((a) => a.splitter === null);
  if (!parent) throw new Error('decideChunking: result has no parent arm');
  const reasons: string[] = [];
  if (parent.tail.n < rule.minTailProbes) {
    reasons.push(`only ${parent.tail.n} tail probes (need ${rule.minTailProbes})`);
  }
  if (parent.short.n < rule.minShortProbes) {
    reasons.push(`only ${parent.short.n} short probes (need ${rule.minShortProbes})`);
  }
  if (reasons.length > 0) return { verdict: 'insufficient-sample', arm: null, reasons };

  const baseTail = parent.tail.mrr ?? 0;
  const baseShort = parent.short.mrr ?? 0;
  const pooled = result.arms.filter((a) => a.splitter !== null);
  const eligible = pooled.filter((a) => baseShort - (a.short.mrr ?? 0) <= rule.maxShortMrrDrop);
  for (const a of pooled) {
    if (!eligible.includes(a)) {
      reasons.push(
        `${a.label}: short-row MRR ${fmt(a.short.mrr)} vs parent ${fmt(baseShort)} drops more than ${rule.maxShortMrrDrop}`,
      );
    }
  }
  if (eligible.length === 0) return { verdict: 'skip', arm: null, reasons };

  const best = Math.max(...eligible.map((a) => a.tail.mrr ?? 0));
  const order = [...new Set(pooled.map((a) => a.splitter))];
  const chosen = eligible
    .filter((a) => (a.tail.mrr ?? 0) >= best - rule.mrrTolerance)
    .sort(
      (a, b) =>
        (a.maxChunks ?? 0) - (b.maxChunks ?? 0) ||
        (a.chunkMargin ?? 0) - (b.chunkMargin ?? 0) ||
        order.indexOf(a.splitter) - order.indexOf(b.splitter),
    )[0];
  const gain = (chosen.tail.mrr ?? 0) - baseTail;
  if (gain < rule.minTailMrrGain) {
    reasons.push(`best arm ${chosen.label} gains ${gain.toFixed(4)} tail MRR, under ${rule.minTailMrrGain}`);
    return { verdict: 'skip', arm: null, reasons };
  }
  reasons.push(
    `${chosen.label}: tail MRR ${fmt(baseTail)} -> ${fmt(chosen.tail.mrr)} (+${gain.toFixed(4)}), ` +
      `short-row MRR ${fmt(baseShort)} -> ${fmt(chosen.short.mrr)}`,
  );
  return { verdict: 'register', arm: chosen, reasons };
}

function fmt(x: number | null): string {
  return x === null ? 'n/a' : x.toFixed(4);
}
