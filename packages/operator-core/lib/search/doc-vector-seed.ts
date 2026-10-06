/**
 * doc-vector-seed — ship precomputed doc_sections vectors with each Server
 * release, so a fresh install does not spend hours of CPU embedding docs that
 * are byte-identical on every install (WI-10004455, plan
 * ship-precomputed-doc-vectors-2026-10-01).
 *
 * Measured on a fresh 0.0.26 Server with no user data: the first boot syncs
 * 12,771 doc_sections rows (papercusp-engineering + papercusp-guidance) with a
 * NULL embedding, and local gemma embeds ~192 of them per 242 s drain, which
 * comes to roughly 5.5 hours at ~1 core on every install.
 *
 * How it fits the existing pipeline (doc-embed-sync.ts → embed-backfill.ts):
 *
 *   1. doc-embed-sync writes section TEXT, keyed (source_key, slug, anchor) and
 *      stamped with page_sha, with a NULL embedding. It stays the only writer
 *      of row content; the seed carries no text.
 *   2. {@link applyShippedDocVectorSeed} runs right after that sync and fills
 *      NULL embeddings from the seed, but only where the row's
 *      (source_key, slug, anchor, page_sha) matches a seed row exactly. Equal
 *      page_sha means the page's title and body are identical to what the seed
 *      was computed from, so the vector is the one the embedder would produce.
 *   3. embed-backfill then finds no NULL rows for the seeded pages and embeds
 *      only what the seed did not cover (changed pages, local docs).
 *
 * Space safety: a seed applies only when its (mode, profileId) is the exact
 * embedding space the backfill sweep would write right now, judged by the same
 * prose-vector-dims rules the sweep uses. On any mismatch the seed is skipped
 * whole and the backfill embeds as it always did, so a vector from another
 * space can never be written.
 *
 * Release cut (the exporter half): sync the release tree's docs into a build
 * database, apply the PREVIOUS release's seed (so unchanged sections are not
 * re-embedded), let the backfill embed the remainder, then
 * {@link exportDocVectorSeed}. The export reports any section it could not
 * cover, so a cut can refuse to ship an incomplete seed.
 *
 * On-disk format (a directory): `manifest.json` lists the rows and their
 * embedding space; `vectors.f32` holds row i's vector as little-endian
 * float32 values [i*dims, (i+1)*dims). pgvector stores float4, so float32
 * round-trips every stored value exactly.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';
import {
  PROSE_VECTOR_DIMS,
  proseProfilePredicateSql,
  resolveProseProfileSelection,
  storedProseIdentityMatches,
  type ProseProfileSelection,
} from './prose-vector-dims';

export const DOC_VECTOR_SEED_FORMAT = 'papercusp-doc-vector-seed';
export const DOC_VECTOR_SEED_VERSION = 1;
export const DOC_VECTOR_SEED_MANIFEST = 'manifest.json';
export const DOC_VECTOR_SEED_VECTORS = 'vectors.f32';

/** The doc corpora built from shipped files: identical on every install of a
 * release, so their vectors can be computed once per release. Harness and
 * project docs are per-install and are never seeded. */
export const SEEDED_DOC_SOURCE_KEYS: readonly string[] = ['papercusp-engineering', 'papercusp-guidance'];

/** Where the Server finds its shipped seed. Bundle wiring sets this. */
export const DOC_VECTOR_SEED_DIR_ENV = 'PAPERCUSP_DOC_VECTOR_SEED_DIR';

/** Rows per UPDATE statement: 200 × 768 floats keeps each statement's
 * parameters around 1.5 MB of vector text. */
const APPLY_BATCH_ROWS = 200;

export type DocVectorSeedRowKey = [sourceKey: string, slug: string, anchor: string, pageSha: string];

export interface DocVectorSeedManifest {
  format: typeof DOC_VECTOR_SEED_FORMAT;
  version: typeof DOC_VECTOR_SEED_VERSION;
  /** Embedder mode that produced the vectors (e.g. 'gemma'). */
  mode: string;
  /** Exact embedding profile id of the vectors. */
  profileId: string;
  dims: number;
  dtype: 'f32le';
  sourceKeys: string[];
  /** Row i's vector is floats [i*dims, (i+1)*dims) of vectors.f32. */
  rows: DocVectorSeedRowKey[];
  createdAt: string;
}

export interface DocVectorSeed {
  manifest: DocVectorSeedManifest;
  vectors: Float32Array;
}

/** The embedding space the backfill sweep writes right now. */
export interface ActiveProseSpace {
  mode: string;
  selection: ProseProfileSelection;
}

const rowKey = (sourceKey: string, slug: string, anchor: string, pageSha: string): string =>
  `${sourceKey}\u0000${slug}\u0000${anchor}\u0000${pageSha}`;

/** pgvector text literal for row `i` of a flat vector array. String(number) is
 * the shortest round-tripping decimal, so the stored float4 is unchanged. */
export function seedVectorLiteral(vectors: Float32Array, i: number, dims: number): string {
  const out = new Array<string>(dims);
  for (let d = 0; d < dims; d += 1) out[d] = String(vectors[i * dims + d]);
  return `[${out.join(',')}]`;
}

/** Parse pgvector's text output (`[0.1,0.2,...]`) into `into` at `offset`. */
function parseVectorText(text: string, dims: number, into: Float32Array, offset: number): void {
  const body = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  const parts = body.length === 0 ? [] : body.split(',');
  if (parts.length !== dims) {
    throw new Error(`doc-vector-seed: stored vector has ${parts.length} dims, expected ${dims}`);
  }
  for (let d = 0; d < dims; d += 1) into[offset + d] = Number(parts[d]);
}

function validateManifest(m: unknown, vectorBytes: number): DocVectorSeedManifest {
  const fail = (why: string): never => {
    throw new Error(`doc-vector-seed: invalid manifest: ${why}`);
  };
  if (!m || typeof m !== 'object') fail('not an object');
  const man = m as Partial<DocVectorSeedManifest>;
  if (man.format !== DOC_VECTOR_SEED_FORMAT) fail(`format ${String(man.format)}`);
  if (man.version !== DOC_VECTOR_SEED_VERSION) fail(`version ${String(man.version)}`);
  if (man.dtype !== 'f32le') fail(`dtype ${String(man.dtype)}`);
  if (typeof man.mode !== 'string' || man.mode.length === 0) fail('mode missing');
  if (typeof man.profileId !== 'string' || man.profileId.length === 0) fail('profileId missing');
  if (!Number.isInteger(man.dims) || (man.dims as number) <= 0) fail(`dims ${String(man.dims)}`);
  if (!Array.isArray(man.rows)) fail('rows missing');
  if (!Array.isArray(man.sourceKeys)) fail('sourceKeys missing');
  const expected = (man.rows as unknown[]).length * (man.dims as number) * 4;
  if (vectorBytes !== expected) fail(`vectors.f32 is ${vectorBytes} bytes, expected ${expected}`);
  for (const r of man.rows as unknown[]) {
    if (!Array.isArray(r) || r.length !== 4 || r.some((v) => typeof v !== 'string')) fail('malformed row key');
  }
  return man as DocVectorSeedManifest;
}

export async function writeDocVectorSeed(dir: string, seed: DocVectorSeed): Promise<void> {
  const { manifest, vectors } = seed;
  if (vectors.length !== manifest.rows.length * manifest.dims) {
    throw new Error(
      `doc-vector-seed: ${vectors.length} floats for ${manifest.rows.length} rows × ${manifest.dims} dims`,
    );
  }
  await mkdir(dir, { recursive: true });
  const bytes = Buffer.alloc(vectors.length * 4);
  for (let i = 0; i < vectors.length; i += 1) bytes.writeFloatLE(vectors[i], i * 4);
  await writeFile(path.join(dir, DOC_VECTOR_SEED_VECTORS), bytes);
  await writeFile(path.join(dir, DOC_VECTOR_SEED_MANIFEST), JSON.stringify(manifest));
}

export async function readDocVectorSeed(dir: string): Promise<DocVectorSeed> {
  const bytes = await readFile(path.join(dir, DOC_VECTOR_SEED_VECTORS));
  const manifest = validateManifest(
    JSON.parse(await readFile(path.join(dir, DOC_VECTOR_SEED_MANIFEST), 'utf8')),
    bytes.length,
  );
  const vectors = new Float32Array(bytes.length / 4);
  for (let i = 0; i < vectors.length; i += 1) vectors[i] = bytes.readFloatLE(i * 4);
  return { manifest, vectors };
}

/** Why a seed cannot be applied in `active`'s space, or null when it can. */
export function seedSpaceMismatch(manifest: DocVectorSeedManifest, active: ActiveProseSpace): string | null {
  if (manifest.dims !== PROSE_VECTOR_DIMS) {
    return `seed dims ${manifest.dims} ≠ prose storage ${PROSE_VECTOR_DIMS}`;
  }
  if (!storedProseIdentityMatches({ profileId: manifest.profileId, mode: manifest.mode }, active.selection)) {
    return `seed space ${manifest.mode}/${manifest.profileId} ≠ active ${active.mode}/${active.selection.profileId}`;
  }
  return null;
}

/** NULL-embedding rows the seed could fill, for the given source keys. Cheap
 * (one indexed count), so a boot with nothing to fill never reads the seed. */
export async function countUnembeddedDocSections(sql: Sql, sourceKeys: readonly string[]): Promise<number> {
  const [row] = await sql.unsafe<Array<{ n: string }>>(
    `SELECT count(*)::text AS n FROM harness_shared.doc_sections
      WHERE source_key = ANY($1::text[]) AND embedding IS NULL`,
    [sourceKeys as string[]],
  );
  return Number(row?.n ?? 0);
}

export type DocVectorSeedApply =
  | { applied: number; seedRows: number }
  | { skipped: 'space-mismatch' | 'invalid-seed'; detail: string }
  | { skipped: 'no-seed' | 'nothing-to-fill' | 'embedder-disabled' };

/**
 * Fill NULL doc_sections embeddings from `seed` where the row's
 * (source_key, slug, anchor, page_sha) matches a seed row. Rows that already
 * hold a vector, and rows whose page changed since the seed was cut, are never
 * touched. Writes the same mode/profile labels the backfill sweep writes.
 */
export async function applyDocVectorSeed(
  sql: Sql,
  seed: DocVectorSeed,
  active: ActiveProseSpace,
): Promise<DocVectorSeedApply> {
  const mismatch = seedSpaceMismatch(seed.manifest, active);
  if (mismatch) return { skipped: 'space-mismatch', detail: mismatch };
  const { rows, dims } = seed.manifest;
  let applied = 0;
  for (let start = 0; start < rows.length; start += APPLY_BATCH_ROWS) {
    const end = Math.min(rows.length, start + APPLY_BATCH_ROWS);
    const cols: string[][] = [[], [], [], [], []];
    for (let i = start; i < end; i += 1) {
      const [sourceKey, slug, anchor, pageSha] = rows[i];
      cols[0].push(sourceKey);
      cols[1].push(slug);
      cols[2].push(anchor);
      cols[3].push(pageSha);
      cols[4].push(seedVectorLiteral(seed.vectors, i, dims));
    }
    const updated = await sql.unsafe<Array<{ slug: string }>>(
      `UPDATE harness_shared.doc_sections d
          SET embedding = v.vec::vector,
              embedding_mode = $6,
              embedding_profile = $7
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
              AS v(source_key, slug, anchor, page_sha, vec)
        WHERE d.source_key = v.source_key AND d.slug = v.slug AND d.anchor = v.anchor
          AND d.page_sha = v.page_sha AND d.embedding IS NULL
       RETURNING d.slug`,
      [cols[0], cols[1], cols[2], cols[3], cols[4], active.mode, active.selection.profileId],
    );
    applied += updated.length;
  }
  return { applied, seedRows: rows.length };
}

/**
 * Resolve the embedding space the backfill sweep would write now, through the
 * sweep's own embedder cascade, so the seed and the sweep can never disagree.
 * Null when embedding is disabled or the profile is not prose-storable.
 */
export async function resolveActiveProseSpace(): Promise<ActiveProseSpace | null> {
  const { resolveBackfillEmbedder } = await import('./embed-backfill');
  const resolved = await resolveBackfillEmbedder();
  if (resolved.mode === 'disabled') return null;
  const selection = resolveProseProfileSelection(resolved.mode, resolved.profile);
  return selection ? { mode: resolved.mode, selection } : null;
}

export interface ShippedSeedDeps {
  seedDir?: () => string | null;
  resolveSpace?: () => Promise<ActiveProseSpace | null>;
  /** Source keys whose NULL rows make reading the seed worthwhile. */
  sourceKeys?: readonly string[];
  log?: (line: string) => void;
}

/** Boot step: apply the release's shipped seed, if there is one and anything
 * is left to fill. Called by doc-embed-sync right after its sync.
 *
 * A seed that cannot be read or fails validation (missing files, truncated
 * vectors, unknown format) is refused BEFORE any row is written and reported
 * as `invalid-seed`: the rows stay NULL and the backfill sweep embeds them as
 * it would with no seed at all. A broken seed costs the saving, never the
 * docs. */
export async function applyShippedDocVectorSeed(sql: Sql, deps: ShippedSeedDeps = {}): Promise<DocVectorSeedApply> {
  const dir = deps.seedDir ? deps.seedDir() : process.env[DOC_VECTOR_SEED_DIR_ENV]?.trim() || null;
  if (!dir) return { skipped: 'no-seed' };
  const pending = await countUnembeddedDocSections(sql, deps.sourceKeys ?? SEEDED_DOC_SOURCE_KEYS);
  if (pending === 0) return { skipped: 'nothing-to-fill' };
  const space = await (deps.resolveSpace ?? resolveActiveProseSpace)();
  if (!space) return { skipped: 'embedder-disabled' };
  const log = deps.log ?? ((line: string) => console.log(line));
  let seed: DocVectorSeed;
  try {
    seed = await readDocVectorSeed(dir);
  } catch (err) {
    const detail = `${dir}: ${(err as Error).message}`;
    log(`[doc-vector-seed] seed refused, leaving ${pending} sections for the sweep: ${detail}`);
    return { skipped: 'invalid-seed', detail };
  }
  const result = await applyDocVectorSeed(sql, seed, space);
  if ('applied' in result) {
    log(`[doc-vector-seed] filled ${result.applied}/${pending} unembedded doc sections from ${dir}`);
  } else if (result.skipped === 'space-mismatch') {
    log(`[doc-vector-seed] seed skipped: ${result.detail}`);
  }
  return result;
}

export interface DocVectorSeedExport {
  seed: DocVectorSeed;
  /** Rows in the exported source keys with no vector in the active space —
   * a release cut should refuse to ship while this is non-zero. */
  uncovered: number;
}

/**
 * Release-cut exporter: every doc_sections row of `sourceKeys` whose vector is
 * in `active`'s space (the same predicate the sweep uses to call a row
 * current), in a stable order.
 */
export async function exportDocVectorSeed(
  sql: Sql,
  active: ActiveProseSpace,
  sourceKeys: readonly string[] = SEEDED_DOC_SOURCE_KEYS,
  now: () => Date = () => new Date(),
): Promise<DocVectorSeedExport> {
  const current = proseProfilePredicateSql(sql, active.selection, 'embedding_profile', 'embedding_mode');
  const rows = await sql<Array<{ source_key: string; slug: string; anchor: string; page_sha: string; vec: string }>>`
    SELECT source_key, slug, anchor, page_sha, embedding::text AS vec
      FROM harness_shared.doc_sections
     WHERE source_key = ANY(${sourceKeys as string[]}::text[])
       AND embedding IS NOT NULL AND ${current}
     ORDER BY source_key, slug, anchor`;
  const [{ total }] = await sql<Array<{ total: string }>>`
    SELECT count(*)::text AS total FROM harness_shared.doc_sections
     WHERE source_key = ANY(${sourceKeys as string[]}::text[])`;
  const dims = PROSE_VECTOR_DIMS;
  const vectors = new Float32Array(rows.length * dims);
  const keys: DocVectorSeedRowKey[] = rows.map((r, i) => {
    parseVectorText(r.vec, dims, vectors, i * dims);
    return [r.source_key, r.slug, r.anchor, r.page_sha];
  });
  return {
    seed: {
      manifest: {
        format: DOC_VECTOR_SEED_FORMAT,
        version: DOC_VECTOR_SEED_VERSION,
        mode: active.mode,
        profileId: active.selection.profileId,
        dims,
        dtype: 'f32le',
        sourceKeys: [...sourceKeys],
        rows: keys,
        createdAt: now().toISOString(),
      },
      vectors,
    },
    uncovered: Number(total) - rows.length,
  };
}

/** Distinct (source_key, slug, anchor, page_sha) keys in a seed — exported for
 * tests and for cut-time diffing against the previous release. */
export function seedRowKeySet(manifest: DocVectorSeedManifest): Set<string> {
  return new Set(manifest.rows.map(([s, sl, a, p]) => rowKey(s, sl, a, p)));
}
