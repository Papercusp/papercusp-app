/**
 * P-028(b) — does `left(text, 2000)` actually cost RECALL, and what should the cut be?
 *
 *   ./node_modules/.bin/tsx packages/operator-core/lib/memory/bench/turn-truncation-width-cli.ts
 *   [--sample 60] [--widths 2000,4000,6000,8000] [--model gemma]
 *
 * ─── THE CLAIM UNDER TEST ─────────────────────────────────────────────────
 * `embed-backfill.ts`'s session_turns bodySql is
 *     CASE WHEN length(text) >= 80 THEN left(text, 2000) ELSE '' END
 * so any turn longer than 2000 chars is embedded on its OPENING ONLY. Measured
 * live 2026-08-03: 33,171 turns (8.14%) exceed 2000 chars, averaging 4,730
 * chars, and 90,569,619 characters sit past the cut. The plan (P-028) asserts
 * that tail is "semantically invisible" and proposes CHUNKING.
 *
 * Two things must be measured before believing either half of that:
 *   1. Is the tail actually unretrievable today? (the defect)
 *   2. Does simply WIDENING the cut fix it — and where does the gain stop?
 *      (the remedy — which is the half that gets skipped, and the half that
 *      burned this plan on P-031, where the obvious remedy turned out to be
 *      byte-identical to the thing it was replacing.)
 *
 * ─── WHY WIDENING IS EVEN A CANDIDATE ─────────────────────────────────────
 * `SIDECAR_MAX_TEXT_CHARS` is 32_000 and `max(length(text))` over the live
 * session_turns table is exactly 8_000 (turns are capped upstream). So EVERY
 * turn already fits the transport with 4x headroom — the 2000-char cut is
 * matched to no transport limit at all. The real ceiling is the MODEL:
 * embeddinggemma-300m has a 2048-token window, and nothing in gemma-embedder.ts
 * passes a max_length, so Transformers.js truncates there silently. 8000 chars
 * of THIS corpus (mixed prose, code, JSON, logs) may or may not fit 2048 tokens
 * — which is exactly why this sweeps widths instead of assuming 4 chars/token.
 *
 * ─── WHY THIS IS A RANKING TEST, NOT A COSINE TEST ────────────────────────
 * D-010 of this plan: cosine under gemma carries a large positive offset —
 * random UNRELATED pairs mean .6119 — so an absolute cosine is uninterpretable
 * and a "similarity went up" result would be meaningless. The only sound
 * measure is RELATIVE: does the correct turn OUTRANK distractors. So each probe
 * is scored by the rank of its true parent turn among the whole sample, and the
 * arms are compared on MRR.
 *
 * ─── FAITHFULNESS ─────────────────────────────────────────────────────────
 * Embedding goes through the SAME `sidecarEmbedBatch` + `resolveProcessSidecarUrl`
 * path `embed-backfill.ts` uses, with the SAME asymmetric kinds ('document' for
 * the turn, 'query' for the probe). Getting that pair wrong would measure a
 * different space than production writes — WI-3616's whole failure mode.
 */
import { sidecarEmbedBatch } from '@papercusp/memory';
import { cosine, isDistinctiveProbe, rankKeys, summarizeRankings } from '@papercusp/search-core';
import pg from 'pg';

import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { EMBED_SIDECAR_CAP_EMBED } from '../embed-sidecar-server';
import { resolveProcessSidecarUrl } from '../embed-sidecar-wiring';
import { splitWindows } from '@papercusp/search';
import {
  MAX_CHUNKS_PER_TURN,
  TURN_CHUNK_CHARS,
  TURN_CHUNK_OVERLAP,
} from '../../search/turn-chunk-sync';

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const MODEL = argOf('--model') ?? 'gemma';
const SAMPLE = Number(argOf('--sample') ?? 60);
const WIDTHS = (argOf('--widths') ?? '2000,3000,4000,6000,8000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

/**
 * Where the probe is cut from — well past the 2000 cut, so it is invisible to
 * the status quo.
 *
 * CONFIGURABLE ON PURPOSE. With a fixed probe offset, "width W scored best" is
 * partly an artifact of W being the first width that CONTAINS the probe, so a
 * single run cannot separate "wider is better" from "the probe just arrived".
 * Re-running at a different offset is the control that separates them.
 */
const PROBE_START = Number(argOf('--probe-at') ?? 3000);
const PROBE_LEN = 240;

/**
 * Chunk width for the chunked arm — see the arm's comment in main().
 *
 * Defaults come from the SHIPPED constants, and the arm splits with the SHIPPED
 * `splitWindows` (P-034; in @papercusp/search since generic-rag-chunking P-002). This bench used to carry its own inline copy of the
 * loop, which was fine while chunking was a hypothesis and became a liability
 * the moment it became production: a benchmark measuring a private copy of the
 * algorithm silently stops being evidence about the real path once the two
 * drift, and nothing fails when they do — both keep "working". Importing means
 * re-running this re-measures production.
 */
const CHUNK = Number(argOf('--chunk') ?? TURN_CHUNK_CHARS);
const CHUNK_OVERLAP = Number(argOf('--chunk-overlap') ?? TURN_CHUNK_OVERLAP);

interface Turn {
  key: string;
  text: string;
}

/**
 * Embed in small batches. A single 60-text call of ~5k-char documents aborts on
 * the client timeout — production batches at BATCH_SIZE for the same reason, so
 * a one-shot call here would be both slower and unlike the path being measured.
 */
async function embedChunked(
  url: string,
  kind: 'document' | 'query',
  texts: string[],
  size = 4,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    const res = await sidecarEmbedBatch(url, {
      model: MODEL,
      kind,
      texts: texts.slice(i, i + size),
      // The 15s default is sized for short texts on an idle box. These are
      // multi-kilobyte documents on a host running at ~100 load, and the
      // default aborts mid-sweep — which reads as a sidecar fault rather than
      // a client budget, so it is raised deliberately here.
      timeoutMs: 180_000,
    });
    out.push(...res.vectors);
  }
  return out;
}

/**
 * Score one arm and print its row.
 *
 * `sim(probeIdx, turnIdx)` is the arm's whole identity — a single vector per
 * turn for the width arms, a max over the turn's chunk vectors for the chunked
 * arm — so every arm is ranked by identical logic and the only thing that
 * varies is the similarity it exposes.
 *
 * RANK-based on purpose (plan D-010): cosine under gemma carries a large
 * positive offset, so absolute similarity is uninterpretable and only the
 * position of the true parent turn among distractors means anything. Ranking
 * and its summary are @papercusp/search-core's (the chunking bench's), so both
 * instruments score by the same rule, including ties going against the target.
 */
function report(
  label: string,
  n: number,
  sim: (probeIdx: number, turnIdx: number) => number,
  note: string,
): void {
  const keys = Array.from({ length: n }, (_, j) => String(j));
  const ranked = keys.map((target, i) => rankKeys(keys, keys.map((_, j) => sim(i, j)), target));
  const s = summarizeRankings(ranked, keys);
  const pct = (x: number | null) => ((x ?? 0) * 100).toFixed(1);
  console.log(
    `${label.padEnd(10)} ${(s.mrr ?? 0).toFixed(4)} ${pct(s.recallAt1).padStart(7)}% ` +
      `${pct(s.recallAt5).padStart(8)}% ${(s.meanRank ?? 0).toFixed(2).padStart(9)}  ${note}`,
  );
}

async function main(): Promise<void> {
  // `resolveProcessSidecarUrl` reads the OPERATOR process's capability registry,
  // which a standalone CLI has no part of — it returns null here even while the
  // sidecar is up and answering. Fall back to the same env var / default port the
  // other bench CLIs use rather than reporting a live sidecar as absent.
  const url =
    argOf('--sidecar') ??
    process.env.PAPERCUSP_EMBED_SIDECAR_URL ??
    (await resolveProcessSidecarUrl(undefined, [EMBED_SIDECAR_CAP_EMBED])) ??
    'http://127.0.0.1:3384';

  const client = new pg.Client({ connectionString: await getHarnessAdminUrl() });
  await client.connect();

  // Turns long enough to HAVE a tail past PROBE_START + PROBE_LEN. Deterministic
  // order so a re-run measures the same sample (this is an instrument, not a survey).
  const { rows } = await client.query<{ key: string; text: string }>(
    `SELECT (workspace_id || '|' || source_kind || '|' || session_id || '|' || turn_idx) AS key,
            text
       FROM harness_shared.session_turns
      WHERE length(text) >= $1
      ORDER BY ingested_at DESC
      LIMIT $2`,
    [PROBE_START + PROBE_LEN, SAMPLE * 3],
  );
  await client.end();

  const turns: Turn[] = [];
  for (const r of rows) {
    if (turns.length >= SAMPLE) break;
    if (isDistinctiveProbe(r.text.slice(PROBE_START, PROBE_START + PROBE_LEN))) turns.push(r);
  }
  if (turns.length < 10) throw new Error(`only ${turns.length} usable turns — sample too small`);

  const probes = turns.map((t) => t.text.slice(PROBE_START, PROBE_START + PROBE_LEN));

  console.log(
    `[turn-truncation] model=${MODEL} turns=${turns.length} ` +
      `probe=[${PROBE_START}..${PROBE_START + PROBE_LEN}) widths=${WIDTHS.join(',')}`,
  );
  console.log(
    `[turn-truncation] mean turn length ${Math.round(
      turns.reduce((a, t) => a + t.text.length, 0) / turns.length,
    )} chars`,
  );

  // 'query' side — asymmetric model, must match production's query kind.
  const qvecs = await embedChunked(url, 'query', probes);

  console.log('\narm          MRR    recall@1  recall@5  meanRank  note');
  console.log('──────────────────────────────────────────────────────────────────');

  const baseline: { width: number; vecs: number[][] } = { width: 0, vecs: [] };
  for (const w of WIDTHS) {
    const docs = turns.map((t) => t.text.slice(0, w));
    const dvecs = await embedChunked(url, 'document', docs);
    if (baseline.vecs.length === 0) {
      baseline.width = w;
      baseline.vecs = dvecs;
    }

    // Does widening change the VECTOR at all? If the model already truncated
    // internally, a wider cut is a no-op and this is how that shows up — a
    // flat MRR alone could not distinguish "no gain" from "no change applied".
    const identical = dvecs.filter((v, j) => cosine(v, baseline.vecs[j]) > 0.9999).length;

    report(String(w), probes.length, (i, j) => cosine(qvecs[i], dvecs[j]), `${identical}/${probes.length}`);
  }

  // ─── THE CHUNKED ARM — what P-028 actually proposes ──────────────────────
  // Every width arm above embeds the turn as ONE vector, so a longer cut spends
  // the same 768 dimensions on more text and the probe's signal is averaged
  // away. That dilution is why the width sweep peaks and then DECLINES, and no
  // choice of single width escapes it.
  //
  // Chunking removes the trade entirely: each chunk gets its own vector, so a
  // turn is scored by its BEST-matching chunk (max, not mean — a turn is
  // relevant if ANY part of it is, which is exactly how a chunked index is
  // queried). Overlap keeps a probe that straddles a boundary from being split
  // across two chunks and diluted in both.
  const chunksPerTurn: string[][] = turns.map((t) =>
    splitWindows(t.text, { size: CHUNK, overlap: CHUNK_OVERLAP, maxChunks: MAX_CHUNKS_PER_TURN }),
  );
  const flat = chunksPerTurn.flat();
  const flatVecs = await embedChunked(url, 'document', flat);
  const chunkVecs: number[][][] = [];
  let off = 0;
  for (const cs of chunksPerTurn) {
    chunkVecs.push(flatVecs.slice(off, off + cs.length));
    off += cs.length;
  }
  const avgChunks = (flat.length / turns.length).toFixed(1);

  report(
    `chunk${CHUNK}`,
    probes.length,
    (i, j) => Math.max(...chunkVecs[j].map((cv) => cosine(qvecs[i], cv))),
    `${avgChunks} ch/turn`,
  );

  console.log(
    '\nReading it: the probe text lives at chars ' +
      `${PROBE_START}-${PROBE_START + PROBE_LEN}, so at width 2000 it is ABSENT from the ` +
      'embedded document. A large MRR gain from 2000 -> wider is the recall the current cut ' +
      'is throwing away. Where MRR stops climbing is the effective model window, and the ' +
      'identical-to-2000 column proves whether a wider cut changed the vector at all.',
  );
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
