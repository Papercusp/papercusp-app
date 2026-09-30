/**
 * generic-rag-chunking-2026-09-29 P-001 — the per-collection chunking bench,
 * the gate for registering a collection with the shared chunk store.
 *
 *   ./node_modules/.bin/tsx packages/operator-core/lib/memory/bench/chunking-bench-cli.ts
 *   --collection plans|operator_turns|work_items|escalations|consult
 *   [--folds 2] [--long 30] [--short 30] [--max-chunks 4,8,16,32]
 *   [--margins 0,0.02,0.04] [--probe-at N] [--seed s] [--model gemma]
 *   [--sidecar URL] [--json PATH]
 *   [--live [--live-margin M] [--predicted PATH]]   (P-015: re-run on stored vectors)
 *
 * The D-016 instrument (turn-truncation-width-cli.ts) generalized: the method
 * lives in @papercusp/search-core (runChunkingBench), and this file supplies
 * papercusp's side of it — which rows, which splitters, and the production
 * embedder.
 *
 * ─── FAITHFULNESS ─────────────────────────────────────────────────────────
 * The parent document of every row is the SAME `bodySql` embed-backfill's
 * TARGETS entry embeds (read from TARGETS, not re-typed here), so the `parent`
 * arm is the vector production actually stores. Chunks use the shipped
 * splitters from @papercusp/search at the shipped turn-chunk width, embedded as
 * `header\nchunk` the way the P-005 text_chunks target will embed them.
 * Embedding goes through `sidecarEmbedBatch` with production's asymmetric kinds
 * ('document' for rows and chunks, 'query' for probes).
 *
 * ─── SAMPLING ─────────────────────────────────────────────────────────────
 * Long rows (text past the 2,000-char window plus one probe) carry TAIL probes;
 * short rows (unchunked, at most 2,000 chars) carry SHORT probes. Each fold is
 * `--long` long rows plus `--short` short rows, so 30 + 30 is a pool of 60
 * (59 distractors, as in D-016); folds are disjoint and their probes are pooled
 * into one summary. Rows are drawn in md5(key || seed) order, one per distinct
 * text: deterministic, so a re-run measures the same sample, and not biased
 * toward recent rows.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { sidecarEmbedBatch } from '@papercusp/memory';
import { splitMarkdown, splitWindows } from '@papercusp/search';
import {
  decideChunking,
  drawShortProbe,
  drawTailProbe,
  runChunkingBench,
  type ArmResult,
  type BenchEmbed,
  type BenchFold,
  type BenchProbe,
  type BenchRow,
  type BenchSplitter,
  type ChunkingDecisionRule,
} from '@papercusp/search-core';
import pg from 'pg';

import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import {
  CONSULT_QUESTIONS_CHUNK_SURFACE,
  OPERATOR_TURNS_CHUNK_SURFACE,
  PLANS_CHUNK_SURFACE,
  surfaceStoreTable,
  WORK_ITEMS_CHUNK_SURFACE,
  type PapercuspChunkSurface,
} from '../../search/chunks/registry';
import { TARGETS } from '../../search/embed-backfill';
import { TURN_CHUNK_CHARS, TURN_CHUNK_OVERLAP } from '../../search/turn-chunk-sync';
import { EMBED_SIDECAR_CAP_EMBED } from '../embed-sidecar-server';
import { resolveProcessSidecarUrl } from '../embed-sidecar-wiring';

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const numList = (s: string, min = 1): number[] =>
  s
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n >= min);

/** The parent vector's window: every TARGETS bodySql cuts its text at 2,000. */
const CUT = 2000;
const PROBE_LEN = 240;

type SplitterName = 'window' | 'markdown';

interface BenchCollection {
  /** A TARGETS table; its bodySql is the parent document. */
  table: string;
  /** The full, uncut text a chunk store would split. */
  textSql: string;
  headerSql?: string;
  splitters: SplitterName[];
  /** The registered chunk surface, when P-001 registered this collection (`--live` reads its stored chunks). */
  surface?: PapercuspChunkSurface;
}

/** The candidate collections P-001 names. Markdown is compared where rows are documents. */
const COLLECTIONS: Record<string, BenchCollection> = {
  plans: {
    table: 'harness_shared.harness_plans',
    textSql: `COALESCE(content, '')`,
    headerSql: `COALESCE(title, '')`,
    splitters: ['window', 'markdown'],
    surface: PLANS_CHUNK_SURFACE,
  },
  operator_turns: {
    table: 'harness_shared.operator_turns',
    textSql: `COALESCE(text, '')`,
    splitters: ['window'],
    surface: OPERATOR_TURNS_CHUNK_SURFACE,
  },
  work_items: {
    table: 'harness_shared.work_items',
    textSql: `COALESCE(summary, '')`,
    headerSql: `COALESCE(title, '')`,
    splitters: ['window', 'markdown'],
    surface: WORK_ITEMS_CHUNK_SURFACE,
  },
  escalations: {
    table: 'harness_shared.harness_escalations',
    textSql: `COALESCE(escalation, '') || E'\\n' || COALESCE(supervisor_notes, '')`,
    splitters: ['window'],
  },
  consult: {
    table: 'harness_shared.consult_state',
    textSql: `COALESCE(question, '')`,
    splitters: ['window'],
    surface: CONSULT_QUESTIONS_CHUNK_SURFACE,
  },
};

/**
 * Chunks carry their nearest heading, the way doc_sections titles keep a
 * continuation part anchored to its section instead of floating as
 * context-free prose. `maxSections` is left unbounded so the row cap is the
 * only cap, which keeps the output a strict prefix (BenchSplitter's contract).
 */
const SPLITTERS: Record<SplitterName, BenchSplitter> = {
  window: (row, max) => splitWindows(row.text, { size: TURN_CHUNK_CHARS, overlap: TURN_CHUNK_OVERLAP, maxChunks: max }),
  markdown: (row, max) =>
    splitMarkdown(row.text, { maxChars: TURN_CHUNK_CHARS, headingDepth: 3, maxSections: Number.MAX_SAFE_INTEGER, maxRows: max }).map(
      (s) => (s.headingPath.length > 0 ? `${s.headingPath[s.headingPath.length - 1]}\n${s.content}` : s.content),
    ),
};

/**
 * The pre-declared call. `maxShortMrrDrop: 0` is the acceptance BAR as written
 * (R-2: an approved collection's short-row MRR must not drop under pooling).
 */
const RULE: ChunkingDecisionRule = {
  minTailProbes: 20,
  minShortProbes: 20,
  minTailMrrGain: 0.05,
  maxShortMrrDrop: Number(argOf('--max-short-drop') ?? 0),
  mrrTolerance: 0.02,
};

const MODEL = argOf('--model') ?? 'gemma';

let embedded = 0;
function makeEmbed(url: string): BenchEmbed {
  return async (kind, texts) => {
    const out: number[][] = [];
    // Small batches: a large call of multi-kilobyte texts aborts on the client
    // timeout, and production batches small for the same reason.
    for (let i = 0; i < texts.length; i += 4) {
      const res = await sidecarEmbedBatch(url, {
        model: MODEL,
        kind,
        texts: texts.slice(i, i + 4),
        // Raised from the 15s default: multi-kilobyte texts on a loaded host.
        timeoutMs: 180_000,
      });
      out.push(...res.vectors);
      embedded += res.vectors.length;
      if (embedded % 200 < 4) process.stderr.write(`[chunking-bench] embedded ${embedded}\n`);
    }
    return out;
  };
}

async function fetchRows(
  client: pg.Client,
  c: BenchCollection,
  minLen: number,
  maxLen: number,
  limit: number,
  seed: string,
): Promise<LiveBenchRow[]> {
  const target = TARGETS.find((t) => t.table === c.table);
  if (!target) throw new Error(`${c.table} has no embed-backfill TARGETS entry`);
  const keySql = target.keyCols.map((k) => `COALESCE(${k}::text, '')`).join(` || '|' || `);
  // --live also reads the stored parent vector and the registry key (text_chunks.parent_key).
  const liveCols = c.surface
    ? `, ${target.embedCol}::text AS pvec, ARRAY[${c.surface.parent.key
        .map((k) => `${typeof k === 'string' ? k : k.column}::text`)
        .join(', ')}]::text[] AS rkey`
    : '';
  // Pick by ctid first, then compute the (possibly expensive) parent document
  // only for the picked rows. One row per distinct text: a question re-asked
  // verbatim in two consults would otherwise put the same text in a pool twice,
  // and every probe of it would have two true parents.
  const { rows } = await client.query<{
    key: string;
    text: string;
    header: string | null;
    parent_doc: string;
    pvec?: string | null;
    rkey?: string[];
  }>(
    `WITH cand AS (
       SELECT DISTINCT ON (md5(${c.textSql})) ctid AS c, ${keySql} AS k FROM ${c.table}
        WHERE length(${c.textSql}) BETWEEN $1 AND $2
        ORDER BY md5(${c.textSql}), md5(${keySql} || $3)),
     pick AS (SELECT c FROM cand ORDER BY md5(k || $3) LIMIT $4)
     SELECT ${keySql} AS key, ${c.textSql} AS text, ${c.headerSql ?? 'NULL'} AS header,
            (${target.bodySql}) AS parent_doc${liveCols}
       FROM ${c.table}
      WHERE ctid IN (SELECT c FROM pick)
      ORDER BY md5(${keySql} || $3)`,
    [minLen, maxLen, seed, limit],
  );
  return rows.map((r) => ({
    key: r.key,
    text: r.text,
    header: r.header ?? undefined,
    parentDoc: r.parent_doc,
    storedParent: r.pvec ? (JSON.parse(r.pvec) as number[]) : null,
    registryKey: r.rkey ?? [],
  }));
}

interface LiveBenchRow extends BenchRow {
  /** The parent vector production stores (null when unembedded); only read by --live. */
  storedParent: number[] | null;
  /** The parent key as text_chunks.parent_key stores it; only read by --live. */
  registryKey: string[];
}

interface StoredChunk {
  content: string;
  vector: number[];
}

/**
 * --live: attach each row's STORED chunks (the rows the chunk sync wrote, with
 * the vectors the embed sweep wrote) and keep only rows production can
 * actually score. A row is dropped, and counted, when its parent vector is
 * unembedded, when it is past the cut but has no stored chunks or an
 * unembedded one, or when a stored chunk is not in its current text (the sync
 * has not caught up with an edit). The P-001 arithmetic then runs unchanged on
 * those vectors: the parent arm is the stored parent vector, and the `stored`
 * splitter returns the stored chunks in chunk order.
 */
async function attachStoredChunks(
  client: pg.Client,
  surface: PapercuspChunkSurface,
  rows: LiveBenchRow[],
): Promise<{
  rows: LiveBenchRow[];
  chunks: Map<string, StoredChunk[]>;
  dropped: { parentUnembedded: number; chunksMissing: number; chunkUnembedded: number; chunkStale: number };
}> {
  const table = surfaceStoreTable(surface);
  const chunks = new Map<string, StoredChunk[]>();
  const dropped = { parentUnembedded: 0, chunksMissing: 0, chunkUnembedded: 0, chunkStale: 0 };
  const kept: LiveBenchRow[] = [];
  for (const r of rows) {
    if (!r.storedParent) {
      dropped.parentUnembedded++;
      continue;
    }
    if (r.text.length > CUT) {
      const { rows: cs } = await client.query<{ content: string; vec: string | null }>(
        `SELECT content, embedding::text AS vec FROM ${table}
          WHERE surface = $1 AND parent_key = $2::text[] ORDER BY chunk_idx`,
        [surface.surface, r.registryKey],
      );
      if (cs.length === 0) {
        dropped.chunksMissing++;
        continue;
      }
      if (cs.some((x) => x.vec === null)) {
        dropped.chunkUnembedded++;
        continue;
      }
      if (cs.some((x) => !r.text.includes(x.content))) {
        dropped.chunkStale++;
        continue;
      }
      chunks.set(
        r.key,
        cs.map((x) => ({ content: x.content, vector: JSON.parse(x.vec!) as number[] })),
      );
    }
    kept.push(r);
  }
  return { rows: kept, chunks, dropped };
}

/** The arm label runChunkingBench gives a splitter at (maxChunks, margin). */
const armLabel = (splitter: string, k: number, m: number) => (m === 0 ? `${splitter}@${k}` : `${splitter}@${k}-m${m}`);

/** Tolerances from the acceptance BARs: R-3/R-4 (0.02 below prediction), R-2 (0.01 short-row MRR drop). */
const LIVE_TOLERANCE = { tail: 0.02, shortDrop: 0.01 };

/**
 * The live re-run against the P-001 prediction for the registered arm (the
 * P-001 arm the registry entry pools at: window@maxChunks, margin): tail
 * recall@1 and tail MRR each at most 0.02 below prediction, and pooling
 * lowering short-row MRR by at most 0.01 against the live parent arm.
 */
function compareWithPrediction(
  result: Awaited<ReturnType<typeof runChunkingBench>>,
  predicted: { result: { arms: ArmResult[] } },
  surface: PapercuspChunkSurface,
  predictedPath: string,
  dropped: Record<string, number>,
) {
  const margin = surface.chunkMargin ?? 0;
  const predictedLabel = armLabel('window', surface.maxChunks, margin);
  const p = predicted.result.arms.find((a) => a.label === predictedLabel);
  if (!p) throw new Error(`--live: ${predictedPath} has no ${predictedLabel} arm`);
  const liveParent = result.arms[0];
  const live = result.arms.find((a) => a.label === armLabel('stored', surface.maxChunks, margin));
  if (!live) throw new Error('--live: the stored arm did not run');
  const d = (x: number | null, y: number | null) => (x === null || y === null ? null : x - y);
  const tailR1Delta = d(live.tail.recallAt1, p.tail.recallAt1);
  const tailMrrDelta = d(live.tail.mrr, p.tail.mrr);
  const shortMrrDrop = d(liveParent.short.mrr, live.short.mrr);
  const pass = (x: number | null, ok: (v: number) => boolean) => (x === null ? 'unmeasured' : ok(x) ? 'pass' : 'fail');
  return {
    surface: surface.surface,
    storeTable: surfaceStoreTable(surface),
    arm: live.label,
    predictedArm: predictedLabel,
    predictedFrom: predictedPath,
    tolerance: LIVE_TOLERANCE,
    dropped,
    predicted: { tailRecallAt1: p.tail.recallAt1, tailMrr: p.tail.mrr, tailN: p.tail.n, shortMrr: p.short.mrr, shortN: p.short.n },
    measured: {
      tailRecallAt1: live.tail.recallAt1,
      tailMrr: live.tail.mrr,
      tailN: live.tail.n,
      shortMrrPooled: live.short.mrr,
      shortMrrParent: liveParent.short.mrr,
      shortN: live.short.n,
      parentTailRecallAt1: liveParent.tail.recallAt1,
      parentTailMrr: liveParent.tail.mrr,
    },
    deltas: { tailRecallAt1: tailR1Delta, tailMrr: tailMrrDelta, shortMrrDrop },
    verdicts: {
      'R-3': pass(tailR1Delta, (v) => v >= -LIVE_TOLERANCE.tail),
      'R-4': pass(tailMrrDelta, (v) => v >= -LIVE_TOLERANCE.tail),
      'R-2': pass(shortMrrDrop, (v) => v <= LIVE_TOLERANCE.shortDrop),
    },
  };
}

/** Keep the first `need` rows that yield a probe, dealt round-robin into folds. */
function deal(rows: BenchRow[], draw: (r: BenchRow) => BenchProbe | null, need: number, folds: number) {
  const out = Array.from({ length: folds }, () => ({ rows: [] as BenchRow[], probes: [] as BenchProbe[] }));
  let kept = 0;
  for (const r of rows) {
    if (kept >= need) break;
    const p = draw(r);
    if (!p) continue;
    out[kept % folds].rows.push(r);
    out[kept % folds].probes.push(p);
    kept++;
  }
  return { folds: out, kept, scanned: rows.length };
}

function fmt(x: number | null, d = 4): string {
  return x === null ? 'n/a' : x.toFixed(d);
}

function printArm(a: ArmResult): void {
  const t = a.tail;
  const s = a.short;
  console.log(
    `${a.label.padEnd(18)} ${fmt(t.mrr)} ${fmt(t.recallAt1, 3).padStart(6)} ${fmt(t.recallAt5, 3).padStart(6)} ` +
      `${fmt(t.meanRank, 2).padStart(6)} ${fmt(t.containedRate, 2).padStart(5)} ${`+${t.improved}/-${t.worsened}`.padStart(7)}` +
      `   ${fmt(s.mrr)} ${fmt(s.recallAt1, 3).padStart(6)} ${`-${s.worsened}`.padStart(4)}`,
  );
}

async function main(): Promise<void> {
  const name = argOf('--collection');
  const c = name ? COLLECTIONS[name] : undefined;
  if (!name || !c) throw new Error(`--collection must be one of: ${Object.keys(COLLECTIONS).join(', ')}`);
  // --live (P-015): re-run the P-001 sample on what production stores — the
  // stored parent vectors and the stored, embedded chunks of the registered
  // surface, pooled at the registry's maxChunks and chunk margin — and compare
  // with the P-001 prediction for that arm. The sample defaults to the P-001
  // artifact's, so the re-run draws the same seeded rows and probes.
  const live = process.argv.includes('--live');
  if (live && !c.surface) throw new Error(`--live needs a registered collection; ${name} has no chunk surface`);
  // --live-margin M: pool the stored chunks at margin M instead of the
  // registry's, so a margin change can be measured on live data before it is
  // made. The verdicts then compare against P-001's prediction for that arm.
  const liveMarginArg = argOf('--live-margin');
  const surface =
    live && liveMarginArg !== undefined ? { ...c.surface!, chunkMargin: Number(liveMarginArg) } : c.surface;
  const predictedPath = argOf('--predicted') ?? `docs/evidence/generic-rag-chunking-2026-09-29/p001-bench-${name}.json`;
  const predicted =
    live && existsSync(predictedPath)
      ? (JSON.parse(readFileSync(predictedPath, 'utf8')) as {
          seed: string;
          sample: { tailProbes: number; shortProbes: number; folds: number };
          result: { arms: ArmResult[] };
        })
      : null;
  if (live && !predicted) throw new Error(`--live needs the P-001 artifact at ${predictedPath} (or --predicted PATH)`);
  const perFold = (n: number) => Math.ceil(n / predicted!.sample.folds);
  const folds = Number(argOf('--folds') ?? predicted?.sample.folds ?? 2);
  const nLong = Number(argOf('--long') ?? (predicted ? perFold(predicted.sample.tailProbes) : 30));
  const nShort = Number(argOf('--short') ?? (predicted ? perFold(predicted.sample.shortProbes) : 30));
  const maxChunks = live ? [surface!.maxChunks] : numList(argOf('--max-chunks') ?? '4,8,16,32');
  // Plain best-match plus margins that make a chunk displace a row only when it
  // beats it clearly — the lever against short-row demotion (R-2).
  const chunkMargins = live
    ? [surface!.chunkMargin ?? 0]
    : numList(argOf('--margins') ?? '0,0.02,0.04,0.06,0.08', 0);
  const probeAt = argOf('--probe-at') !== undefined ? Number(argOf('--probe-at')) : undefined;
  const seed = argOf('--seed') ?? predicted?.seed ?? 'p001';
  const jsonPath = argOf('--json');

  // A standalone CLI is outside the operator's capability registry, so the
  // resolver returns null even while the sidecar answers; fall back as the
  // other bench CLIs do.
  const url =
    argOf('--sidecar') ??
    process.env.PAPERCUSP_EMBED_SIDECAR_URL ??
    (await resolveProcessSidecarUrl(undefined, [EMBED_SIDECAR_CAP_EMBED])) ??
    'http://127.0.0.1:3384';

  const client = new pg.Client({ connectionString: await getHarnessAdminUrl() });
  await client.connect();
  // length() is int4, so the open upper bound is int4's max, not MAX_SAFE_INTEGER.
  let longRows: BenchRow[] = await fetchRows(client, c, CUT + PROBE_LEN, 2_147_483_647, nLong * folds * 3, seed);
  let shortRows: BenchRow[] = await fetchRows(client, c, PROBE_LEN * 2, CUT, nShort * folds * 3, seed);
  let stored: Awaited<ReturnType<typeof attachStoredChunks>> | null = null;
  if (live) {
    const l = await attachStoredChunks(client, surface!, longRows as LiveBenchRow[]);
    const s = await attachStoredChunks(client, surface!, shortRows as LiveBenchRow[]);
    for (const [k, v] of s.chunks) l.chunks.set(k, v);
    for (const k of Object.keys(l.dropped) as Array<keyof typeof l.dropped>) l.dropped[k] += s.dropped[k];
    stored = { rows: [...l.rows, ...s.rows], chunks: l.chunks, dropped: l.dropped };
    longRows = l.rows;
    shortRows = s.rows;
    console.log(`[chunking-bench] --live: surface=${surface!.surface} margin=${surface!.chunkMargin ?? 0} dropped ${JSON.stringify(l.dropped)}`);
  }
  const census = await client.query<{ total: string; over: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE length(${c.textSql}) > ${CUT}) AS over FROM ${c.table}`,
  );
  await client.end();

  const longDeal = deal(longRows, (r) => drawTailProbe(r, { cut: CUT, length: PROBE_LEN, at: probeAt }), nLong * folds, folds);
  const shortDeal = deal(shortRows, (r) => drawShortProbe(r, PROBE_LEN), nShort * folds, folds);
  const benchFolds: BenchFold[] = longDeal.folds.map((f, i) => ({
    rows: [...f.rows, ...shortDeal.folds[i].rows],
    probes: [...f.probes, ...shortDeal.folds[i].probes],
  }));

  const total = Number(census.rows[0].total);
  const over = Number(census.rows[0].over);
  console.log(
    `[chunking-bench] collection=${name} table=${c.table} model=${MODEL} seed=${seed} ` +
      `probe=${probeAt === undefined ? 'seeded-tail' : `at-${probeAt}`} len=${PROBE_LEN} ` +
      `chunk=${TURN_CHUNK_CHARS}/${TURN_CHUNK_OVERLAP} caps=${maxChunks.join(',')} margins=${chunkMargins.join(',')} ` +
      `splitters=${c.splitters.join(',')}`,
  );
  console.log(
    `[chunking-bench] rows past the cut: ${over} of ${total} (${((over / Math.max(total, 1)) * 100).toFixed(1)}%). ` +
      `tail probes ${longDeal.kept} (from ${longDeal.scanned} long rows), short probes ${shortDeal.kept} ` +
      `(from ${shortDeal.scanned} short rows), folds ${folds}`,
  );

  let splitters: Record<string, BenchSplitter> = Object.fromEntries(c.splitters.map((s) => [s, SPLITTERS[s]]));
  let embed = makeEmbed(url);
  if (stored) {
    // The stored chunks stand in for a splitter, and the stored vectors for the
    // document embedder; probes are still embedded as queries, as production does.
    const chunks = stored.chunks;
    splitters = { stored: (row, max) => (chunks.get(row.key) ?? []).slice(0, max).map((x) => x.content) };
    const vectors = new Map<string, number[]>();
    for (const r of stored.rows as LiveBenchRow[]) {
      vectors.set(r.parentDoc, r.storedParent!);
      for (const x of chunks.get(r.key) ?? []) vectors.set(r.header ? `${r.header}\n${x.content}` : x.content, x.vector);
    }
    const queryEmbed = embed;
    embed = async (kind, texts) => {
      if (kind === 'query') return queryEmbed(kind, texts);
      return texts.map((t) => {
        const v = vectors.get(t);
        if (!v) throw new Error(`--live: no stored vector for a ${t.length}-char document text`);
        return v;
      });
    };
  }
  const started = Date.now();
  const result = await runChunkingBench({
    folds: benchFolds,
    splitters,
    maxChunks,
    chunkMargins,
    minChunkTextChars: CUT,
    embed,
  });
  const decision = decideChunking(result, RULE);
  const liveReport = stored ? compareWithPrediction(result, predicted!, surface!, predictedPath, stored.dropped) : null;
  if (liveReport) console.log(`[chunking-bench] --live verdicts ${JSON.stringify(liveReport.verdicts)}`);

  const parentArm = result.arms[0];
  console.log(
    `\npool sizes ${result.poolSizes.join(',')}; scored probes: tail ${parentArm.tail.n}, short ${parentArm.short.n} ` +
      `(ambiguous dropped ${result.ambiguousProbesDropped})`,
  );
  for (const [s, st] of Object.entries(result.splitters)) {
    const atCap = Object.entries(st.rowsAtCap)
      .map(([k, n]) => `@${k}:${n}`)
      .join(' ');
    console.log(`splitter ${s}: ${st.chunkedRows} chunked rows, ${st.meanChunks.toFixed(1)} chunks/row at max cap; rows filling the cap ${atCap}`);
  }
  console.log('\n                   ─────────────── tail (past the cut) ───────────────   ── short rows ──');
  console.log('arm                MRR       r@1    r@5  mRank  cont.  +/-vsP     MRR       r@1  -vsP');
  for (const a of result.arms) printArm(a);
  console.log(`\nverdict: ${decision.verdict}${decision.arm ? ` (${decision.arm.label})` : ''}`);
  for (const r of decision.reasons) console.log(`  - ${r}`);
  console.log(`[chunking-bench] ${embedded} texts embedded in ${((Date.now() - started) / 1000).toFixed(0)}s`);

  if (jsonPath) {
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          collection: name,
          table: c.table,
          model: MODEL,
          seed,
          probe: { class: probeAt === undefined ? 'seeded-tail' : `at-${probeAt}`, length: PROBE_LEN, cut: CUT },
          chunk: { size: TURN_CHUNK_CHARS, overlap: TURN_CHUNK_OVERLAP },
          census: { rows: total, pastCut: over },
          sample: { tailProbes: longDeal.kept, shortProbes: shortDeal.kept, folds },
          rule: RULE,
          result,
          decision: { verdict: decision.verdict, arm: decision.arm?.label ?? null, reasons: decision.reasons },
          ...(liveReport ? { live: liveReport } : {}),
        },
        null,
        2,
      ),
    );
    console.log(`[chunking-bench] wrote ${jsonPath}`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
