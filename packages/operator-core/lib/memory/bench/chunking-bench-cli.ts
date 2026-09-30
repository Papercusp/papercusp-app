/**
 * generic-rag-chunking-2026-09-29 P-001 — the per-collection chunking bench,
 * the gate for registering a collection with the shared chunk store.
 *
 *   ./node_modules/.bin/tsx packages/operator-core/lib/memory/bench/chunking-bench-cli.ts
 *   --collection plans|operator_turns|work_items|escalations|consult
 *   [--folds 2] [--long 30] [--short 30] [--max-chunks 4,8,16,32]
 *   [--margins 0,0.02,0.04] [--probe-at N] [--seed s] [--model gemma]
 *   [--sidecar URL] [--json PATH]
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
import { mkdirSync, writeFileSync } from 'node:fs';
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
}

/** The candidate collections P-001 names. Markdown is compared where rows are documents. */
const COLLECTIONS: Record<string, BenchCollection> = {
  plans: {
    table: 'harness_shared.harness_plans',
    textSql: `COALESCE(content, '')`,
    headerSql: `COALESCE(title, '')`,
    splitters: ['window', 'markdown'],
  },
  operator_turns: {
    table: 'harness_shared.operator_turns',
    textSql: `COALESCE(text, '')`,
    splitters: ['window'],
  },
  work_items: {
    table: 'harness_shared.work_items',
    textSql: `COALESCE(summary, '')`,
    headerSql: `COALESCE(title, '')`,
    splitters: ['window', 'markdown'],
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
): Promise<BenchRow[]> {
  const target = TARGETS.find((t) => t.table === c.table);
  if (!target) throw new Error(`${c.table} has no embed-backfill TARGETS entry`);
  const keySql = target.keyCols.map((k) => `COALESCE(${k}::text, '')`).join(` || '|' || `);
  // Pick by ctid first, then compute the (possibly expensive) parent document
  // only for the picked rows. One row per distinct text: a question re-asked
  // verbatim in two consults would otherwise put the same text in a pool twice,
  // and every probe of it would have two true parents.
  const { rows } = await client.query<{ key: string; text: string; header: string | null; parent_doc: string }>(
    `WITH cand AS (
       SELECT DISTINCT ON (md5(${c.textSql})) ctid AS c, ${keySql} AS k FROM ${c.table}
        WHERE length(${c.textSql}) BETWEEN $1 AND $2
        ORDER BY md5(${c.textSql}), md5(${keySql} || $3)),
     pick AS (SELECT c FROM cand ORDER BY md5(k || $3) LIMIT $4)
     SELECT ${keySql} AS key, ${c.textSql} AS text, ${c.headerSql ?? 'NULL'} AS header,
            (${target.bodySql}) AS parent_doc
       FROM ${c.table}
      WHERE ctid IN (SELECT c FROM pick)
      ORDER BY md5(${keySql} || $3)`,
    [minLen, maxLen, seed, limit],
  );
  return rows.map((r) => ({ key: r.key, text: r.text, header: r.header ?? undefined, parentDoc: r.parent_doc }));
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
  const folds = Number(argOf('--folds') ?? 2);
  const nLong = Number(argOf('--long') ?? 30);
  const nShort = Number(argOf('--short') ?? 30);
  const maxChunks = numList(argOf('--max-chunks') ?? '4,8,16,32');
  // Plain best-match plus margins that make a chunk displace a row only when it
  // beats it clearly — the lever against short-row demotion (R-2).
  const chunkMargins = numList(argOf('--margins') ?? '0,0.02,0.04,0.06,0.08', 0);
  const probeAt = argOf('--probe-at') !== undefined ? Number(argOf('--probe-at')) : undefined;
  const seed = argOf('--seed') ?? 'p001';
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
  const longRows = await fetchRows(client, c, CUT + PROBE_LEN, 2_147_483_647, nLong * folds * 3, seed);
  const shortRows = await fetchRows(client, c, PROBE_LEN * 2, CUT, nShort * folds * 3, seed);
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

  const splitters = Object.fromEntries(c.splitters.map((s) => [s, SPLITTERS[s]]));
  const started = Date.now();
  const result = await runChunkingBench({
    folds: benchFolds,
    splitters,
    maxChunks,
    chunkMargins,
    minChunkTextChars: CUT,
    embed: makeEmbed(url),
  });
  const decision = decideChunking(result, RULE);

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
