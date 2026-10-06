/**
 * datatype-registry-store.ts — PG CRUD for the DATATYPE REGISTRY
 * (`harness_shared.datatype_registry`, migration 421;
 * reflexive-platform-extensibility-datatypes-2026-06-24 P-013).
 *
 * A DATATYPE is a reusable, named entity TYPE declared from inside Papercusp via
 * meta:define-datatype (P-001): the shared shape (`bet`, `wager`, `forecast`,
 * `position`, …) that blueprints reference by name through `dependencies.datatypes`
 * (P-012, D-009). Authority is DEDUP-ONLY (D-010): a hard unique id (the composite
 * PK) + a soft semantic-similarity surface at declaration ({@link findSimilarDatatypes}).
 *
 * WORKSPACE-LOCAL (D-010 local tier): every function takes `workspaceId` and scopes
 * to it (the table's RLS isolates by workspace too). Published/shared datatypes
 * additionally ride the Comb (the `published` flag; the Comb leg is layered later).
 *
 * Transport-agnostic: every function takes the `sql` handle so the same code serves
 * the live `getOrgPg()` connection and an integration test's handle. Pure PG: the
 * caller computes the embedding (a `number[] | null`, 384-dim) and passes it in
 * (dedup rides @papercusp/search over the columns this store writes, D-010).
 *
 * Server-only.
 */
import type postgres from 'postgres';
import type { EmbedderMode } from '@papercusp/memory';
import {
  proseProfilePredicateSql,
  type ProseProfileSelection,
} from './search/prose-vector-dims';
import { parseDatatypeDisplay, type DatatypeDisplaySpec } from './datatype-display';

/** The two-tier datatype model (D-002) + the projection flavor (D-008). */
export const DATATYPE_TIERS = ['generic-kind', 'first-class', 'projection'] as const;
export type DatatypeTier = (typeof DATATYPE_TIERS)[number];
export function isDatatypeTier(t: string): t is DatatypeTier {
  return (DATATYPE_TIERS as readonly string[]).includes(t);
}

/**
 * The NATURE of a datatype (enterprise-data-sources-2026-10-01 D-001 / P-008): the one
 * boundary between WORK and DATA. `work` = something to do (claimable by its audience);
 * `record` = structured state of an entity; `document` = content read and searched as
 * prose; `event` = something that happened at a point in time. Tier says HOW a datatype is
 * stored; nature says WHAT it is. datatype_registry is the source of truth for nature
 * (D-008); P-010 stamps it onto work_items rows at mint.
 */
export const DATATYPE_NATURES = ['work', 'record', 'document', 'event'] as const;
export type DatatypeNature = (typeof DATATYPE_NATURES)[number];
export function isDatatypeNature(n: unknown): n is DatatypeNature {
  return typeof n === 'string' && (DATATYPE_NATURES as readonly string[]).includes(n);
}

/** Who may claim WORK (D-001): `human` work (email-draft-proposal) is never agent-claimable. */
export const WORK_AUDIENCES = ['agent', 'human'] as const;
export type WorkAudience = (typeof WORK_AUDIENCES)[number];
export function isWorkAudience(a: unknown): a is WorkAudience {
  return typeof a === 'string' && (WORK_AUDIENCES as readonly string[]).includes(a);
}

/**
 * The built-in work_item kinds and their nature (D-013 §1). Migration 1318 seeds the same
 * rows into datatype_registry (tier first-class, work_item_kind = the kind); this constant is
 * the fallback for a workspace without those rows. A unit test pins the constant to the
 * migration seed and to WORK_ITEM_KINDS, so the three cannot drift.
 */
export const BUILTIN_WORK_ITEM_KIND_NATURES = {
  feature: { nature: 'work', audience: 'agent' },
  chunk: { nature: 'work', audience: 'agent' },
  bug: { nature: 'work', audience: 'agent' },
  change: { nature: 'work', audience: 'agent' },
  task: { nature: 'work', audience: 'agent' },
} as const satisfies Record<string, { nature: DatatypeNature; audience: WorkAudience | null }>;
export type BuiltinWorkItemKind = keyof typeof BUILTIN_WORK_ITEM_KIND_NATURES;
export function isBuiltinWorkItemKind(id: string): id is BuiltinWorkItemKind {
  return Object.prototype.hasOwnProperty.call(BUILTIN_WORK_ITEM_KIND_NATURES, id);
}

/** A nature plus its audience (non-null exactly when nature = work). */
export interface DatatypeNatureSpec {
  nature: DatatypeNature;
  audience: WorkAudience | null;
}

/**
 * D-013 §5 LEGACY rule — for data that predates natures (an imported package or bundle with
 * no `nature`), NEVER a default for a new declaration: generic-kind keeps today's claim
 * behaviour (work/agent), first-class and projection become records. Mirrors migration
 * 1318's backfill and its expand-phase fill trigger.
 */
export function legacyNatureForTier(tier: DatatypeTier): DatatypeNatureSpec {
  return tier === 'generic-kind' ? { nature: 'work', audience: 'agent' } : { nature: 'record', audience: null };
}

export type NatureSpecCheck =
  | { ok: true; value: DatatypeNatureSpec }
  | { ok: false; reason: 'invalid_nature' | 'audience_required' | 'audience_not_allowed'; message: string };

/**
 * Validate a nature + audience pair against the table CHECK (audience set exactly when
 * nature = work). Work with no audience is REFUSED rather than defaulted to `agent`: the
 * audience is what keeps human-decision work out of the agent queue, so it is declared, not
 * assumed.
 */
export function checkNatureSpec(nature: unknown, audience: unknown): NatureSpecCheck {
  if (!isDatatypeNature(nature)) {
    return {
      ok: false,
      reason: 'invalid_nature',
      message: `nature must be one of ${DATATYPE_NATURES.join(' | ')} (got ${JSON.stringify(nature)})`,
    };
  }
  if (nature === 'work') {
    if (!isWorkAudience(audience)) {
      return {
        ok: false,
        reason: 'audience_required',
        message: `nature "work" needs an audience: ${WORK_AUDIENCES.join(' | ')} (human work is never agent-claimable)`,
      };
    }
    return { ok: true, value: { nature, audience } };
  }
  if (audience != null) {
    return {
      ok: false,
      reason: 'audience_not_allowed',
      message: `audience applies only to nature "work"; a ${nature} has no claimant — omit audience`,
    };
  }
  return { ok: true, value: { nature, audience: null } };
}

/**
 * Derive a stable kebab slug (the datatype id / PK) from a free-text name. Lowercase,
 * non-alphanumerics → single dashes, trimmed. Pure → exhaustively unit-testable.
 * `'Bet Thesis'` → `'bet-thesis'`; `'  P&L  '` → `'p-l'`.
 */
export function slugifyDatatype(name: string): string {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** One crude de-pluralization step. Not linguistics — see {@link singularizeToken}. */
function singularizeOnce(t: string): string {
  if (/ies$/.test(t) && t.length > 4) return `${t.slice(0, -3)}y`;
  if (/(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (/s$/.test(t) && !/ss$/.test(t) && t.length > 3) return t.slice(0, -1);
  return t;
}

/**
 * Singularize ONE slug token, to a FIXED POINT. Deliberately crude and TOTAL — it is a
 * canonicalization, not linguistics: the only property that matters is that a word and
 * its plural land on the SAME key. Being wrong about English is harmless as long as it
 * is wrong CONSISTENTLY on both sides.
 *
 * The fixed point is what makes it consistent, and it is not cosmetic. A singular that
 * merely ENDS in 's' ('status', 'bias') gets its 's' stripped by the bare-s rule, while
 * its plural takes the '-es' rule: one pass sends 'status' → 'statu' but 'statuses' →
 * 'status', and the pair does NOT collide — the gate misses the duplicate. Iterating to
 * stability sends both to 'statu'. Equivalently: canonical(canonical(x)) === canonical(x),
 * the property any canonicalization owes its callers.
 */
function singularizeToken(t: string): string {
  let out = t;
  for (let i = 0; i < 4; i++) {
    const next = singularizeOnce(out);
    if (next === out) return out;
    out = next;
  }
  return out;
}

/**
 * The CANONICAL duplicate key for a datatype name (EI-10562) — the deterministic,
 * threshold-free half of the dedup gate.
 *
 * The registry's whole job is preventing DUPLICATE datatypes, and the duplicate that
 * actually happens is a SLUG VARIANT: someone declares `orders` when `order` exists.
 * That case can be decided with CERTAINTY, so it is decided by an exact test — set
 * membership on this key — and never by a similarity score.
 *
 * Why not a score: see EI-10562. On live data, the cosine between the ONE true
 * near-duplicate pair in the registry (bet/wager, 0.752) and merely-same-domain
 * DISTINCT pairs (bet/forecast, 0.710) differs by 0.04. Similarity cannot separate a
 * duplicate from a neighbour here at ANY threshold, so it is not allowed to refuse —
 * it only ranks the advisory `related[]` list. Certainty gets a gate; uncertainty gets
 * advice.
 */
export function canonicalDatatypeKey(name: string): string {
  return slugifyDatatype(name).split('-').filter(Boolean).map(singularizeToken).join('-');
}

/**
 * Find an EXISTING active datatype whose canonical key collides with `name` — i.e. an
 * unmistakable duplicate under {@link canonicalDatatypeKey} (`orders` vs `order`), never
 * a mere semantic neighbour. `excludeId` skips the row being re-declared in place.
 *
 * Canonicalization lives in TS on BOTH sides (never half in SQL) so the key can never
 * drift between the write path and the check path. The registry is bounded by design
 * (a workspace has tens of datatypes, not millions), so scanning ids is the right call.
 */
export async function findCanonicalDuplicate(
  sql: postgres.Sql,
  workspaceId: string,
  name: string,
  excludeId?: string,
): Promise<{ id: string; title: string } | null> {
  const key = canonicalDatatypeKey(name);
  if (!key) return null;
  const rows = await sql<{ id: string; title: string }[]>`
    SELECT id, title
      FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active'`;
  for (const r of rows) {
    if (excludeId && r.id === excludeId) continue;
    if (canonicalDatatypeKey(r.id) === key) return { id: r.id, title: r.title };
  }
  return null;
}

export interface DatatypeRow {
  id: string;
  workspaceId: string;
  potSlug: string | null;
  title: string;
  description: string;
  tier: DatatypeTier;
  /** The registered work_item kind (generic-kind tier; accepted by work_items:create — P-001). */
  workItemKind: string | null;
  /** D-001: work | record | document | event — the WORK/DATA boundary (source of truth, D-008). */
  nature: DatatypeNature;
  /** Who may claim it; non-null exactly when nature = work. */
  audience: WorkAudience | null;
  /** JSON-Schema shape the kind's payload is validated against. */
  payloadSchema: Record<string, unknown> | null;
  /** Declarative editor + compact-rendering contract (P-024); never executable code. */
  display: DatatypeDisplaySpec | null;
  /** 'papercusp' | 'engine:<name>' — projection tier's single writer is external (D-008). */
  authoritativeWriter: string;
  /** The REQUIRED self-improvement surface (P-010): { improvements, scorecard, gym }. */
  selfImprovement: Record<string, unknown> | null;
  status: string;
  published: boolean;
  /** Global/shared-tier moderation state (migration 425, D-010): 'none' (local only) |
   *  'pending' | 'approved' | 'rejected'. Distinct from `status` (local usability). */
  reviewStatus: string;
  tags: string[];
  /** True when an embedding is stored; the raw vector itself is not mapped back. */
  hasEmbedding: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertDatatypeInput {
  /** Stable kebab slug (the id, unique within the workspace). Derive via {@link slugifyDatatype}. */
  id: string;
  workspaceId: string;
  potSlug?: string | null;
  title: string;
  description: string;
  tier: DatatypeTier;
  workItemKind?: string | null;
  /** REQUIRED (P-008): every write states what the datatype IS. Checked by {@link checkNatureSpec}. */
  nature: DatatypeNature;
  /** Required when nature = work, refused otherwise. */
  audience?: WorkAudience | null;
  payloadSchema?: Record<string, unknown> | null;
  display?: DatatypeDisplaySpec | null;
  authoritativeWriter?: string | null;
  selfImprovement?: Record<string, unknown> | null;
  published?: boolean;
  tags?: string[];
  /** title+description embedding (shared prose width). null when unavailable. */
  embedding?: number[] | null;
  embeddingMode?: EmbedderMode | null;
  embeddingProfile?: ProseProfileSelection | null;
  createdBy?: string | null;
}

type DbRow = {
  id: string;
  workspace_id: string;
  pot_slug: string | null;
  title: string;
  description: string;
  tier: string;
  work_item_kind: string | null;
  nature: string;
  audience: string | null;
  payload_schema: Record<string, unknown> | null;
  display: Record<string, unknown> | null;
  authoritative_writer: string;
  self_improvement: Record<string, unknown> | null;
  status: string;
  published: boolean;
  review_status: string;
  tags: string[] | null;
  has_embedding: boolean;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const asIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

/** JSONB columns come back parsed on some driver configs and as raw text on others
 *  (e.g. the integration fixture's admin client) — normalize to an object|null. */
function parseJsonbMaybe(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function mapRow(r: DbRow): DatatypeRow {
  const rawDisplay = parseJsonbMaybe(r.display);
  const parsedDisplay = rawDisplay ? parseDatatypeDisplay(rawDisplay) : null;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    potSlug: r.pot_slug,
    title: r.title,
    description: r.description,
    tier: (isDatatypeTier(r.tier) ? r.tier : 'generic-kind'),
    workItemKind: r.work_item_kind,
    // The column is NOT NULL + CHECKed (migration 1318); the fallback only guards a row read
    // through a stale schema, and maps it by the same legacy rule the migration applied.
    ...(isDatatypeNature(r.nature)
      ? { nature: r.nature, audience: isWorkAudience(r.audience) ? r.audience : null }
      : legacyNatureForTier(isDatatypeTier(r.tier) ? r.tier : 'generic-kind')),
    payloadSchema: parseJsonbMaybe(r.payload_schema),
    display: parsedDisplay?.ok ? parsedDisplay.value : null,
    authoritativeWriter: r.authoritative_writer,
    selfImprovement: parseJsonbMaybe(r.self_improvement),
    status: r.status,
    published: r.published,
    reviewStatus: r.review_status,
    tags: r.tags ?? [],
    hasEmbedding: r.has_embedding,
    createdBy: r.created_by,
    createdAt: asIso(r.created_at),
    updatedAt: asIso(r.updated_at),
  };
}

/** SELECT-list shared by every read (the raw VECTOR is never serialized back — only its presence). */
const SELECT_COLS = (sql: postgres.Sql | postgres.TransactionSql) => sql`
  id, workspace_id, pot_slug, title, description, tier, work_item_kind, nature, audience,
  payload_schema, display, authoritative_writer, self_improvement, status, published, review_status, tags,
  (embedding IS NOT NULL) AS has_embedding, created_by, created_at, updated_at
`;

/**
 * Declare a datatype, or update its definition in place for an existing
 * (workspace_id, id). updated_at bumps; created_by/created_at are PRESERVED on
 * update. Embedding is overwritten only when a non-null vector is supplied — a
 * re-declare without an available embedder must not WIPE a previously computed one.
 */
export async function upsertDatatype(
  sql: postgres.Sql,
  input: UpsertDatatypeInput,
): Promise<DatatypeRow> {
  const embeddingLiteral =
    input.embedding && input.embedding.length > 0 ? `[${input.embedding.join(',')}]` : null;
  if (embeddingLiteral && (!input.embeddingMode || !input.embeddingProfile)) {
    throw new Error('upsertDatatype: a stored embedding requires exact mode and profile provenance');
  }
  const natureCheck = checkNatureSpec(input.nature, input.audience ?? null);
  if (!natureCheck.ok) throw new Error(`upsertDatatype: ${natureCheck.reason}: ${natureCheck.message}`);
  const { nature, audience } = natureCheck.value;
  const rows = await sql<DbRow[]>`
    INSERT INTO harness_shared.datatype_registry
      (id, workspace_id, pot_slug, title, description, tier, work_item_kind, nature, audience,
       payload_schema, display, authoritative_writer, self_improvement, published, tags,
       embedding, embedding_mode, embedding_profile, created_by, updated_at)
    VALUES (
      ${input.id}, ${input.workspaceId}, ${input.potSlug ?? null}, ${input.title},
      ${input.description}, ${input.tier}, ${input.workItemKind ?? null}, ${nature}, ${audience},
      ${input.payloadSchema ? JSON.stringify(input.payloadSchema) : null}::text::jsonb,
      ${input.display ? JSON.stringify(input.display) : null}::text::jsonb,
      ${input.authoritativeWriter ?? 'papercusp'},
      ${input.selfImprovement ? JSON.stringify(input.selfImprovement) : null}::text::jsonb,
      ${input.published ?? false}, ${input.tags ?? []},
      ${embeddingLiteral}::vector, ${input.embeddingMode ?? null},
      ${input.embeddingProfile?.profileId ?? null}, ${input.createdBy ?? null}, now()
    )
    ON CONFLICT (workspace_id, id) DO UPDATE SET
      pot_slug            = EXCLUDED.pot_slug,
      title                = EXCLUDED.title,
      description          = EXCLUDED.description,
      tier                 = EXCLUDED.tier,
      work_item_kind       = EXCLUDED.work_item_kind,
      nature               = EXCLUDED.nature,
      audience             = EXCLUDED.audience,
      payload_schema       = EXCLUDED.payload_schema,
      display              = EXCLUDED.display,
      authoritative_writer = EXCLUDED.authoritative_writer,
      self_improvement     = EXCLUDED.self_improvement,
      published            = EXCLUDED.published,
      tags                 = EXCLUDED.tags,
      -- keep the existing embedding when this write carries none (no embedder)
      embedding            = COALESCE(EXCLUDED.embedding, harness_shared.datatype_registry.embedding),
      embedding_mode       = CASE WHEN EXCLUDED.embedding IS NULL
        THEN harness_shared.datatype_registry.embedding_mode ELSE EXCLUDED.embedding_mode END,
      embedding_profile    = CASE WHEN EXCLUDED.embedding IS NULL
        THEN harness_shared.datatype_registry.embedding_profile ELSE EXCLUDED.embedding_profile END,
      updated_at           = now()
    RETURNING ${SELECT_COLS(sql)}`;
  return mapRow(rows[0]);
}

/** Fetch one datatype by id within a workspace. Null when absent. */
export async function getDatatype(
  sql: postgres.Sql | postgres.TransactionSql,
  workspaceId: string,
  id: string,
): Promise<DatatypeRow | null> {
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND id = ${id}
     LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

const DEFAULT_LIST_LIMIT = 1000;
const MAX_LIST_LIMIT = 2000;
function clampLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(limit)));
}

/** List a workspace's datatypes (newest first). Optionally filter by tier / active-only. */
export async function listDatatypes(
  sql: postgres.Sql,
  workspaceId: string,
  opts: { limit?: number; tier?: DatatypeTier; activeOnly?: boolean } = {},
): Promise<DatatypeRow[]> {
  const lim = clampLimit(opts.limit);
  const tierFilter = opts.tier ? sql`AND tier = ${opts.tier}` : sql``;
  const statusFilter = opts.activeOnly === false ? sql`` : sql`AND status = 'active'`;
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} ${tierFilter} ${statusFilter}
     ORDER BY updated_at DESC, id
     LIMIT ${lim}`;
  return rows.map(mapRow);
}

/** Count a workspace's active datatypes. */
export async function countDatatypes(sql: postgres.Sql, workspaceId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active'`;
  return rows[0]?.n ?? 0;
}

export interface DatatypeSummary {
  total: number;
  /** counts per tier (generic-kind / first-class / projection). */
  byTier: Record<string, number>;
  /** counts per global review state (none / pending / approved / rejected). */
  byReviewStatus: Record<string, number>;
  /** how many are flagged published (any review state). */
  published: number;
}

/**
 * Workspace observability over the datatype registry (P-011): active datatypes broken down by
 * tier and global review-status — one grouped scan, aggregated in JS. The at-a-glance "what
 * datatypes does this workspace have, and where are they in the local→shared graduation".
 */
export async function datatypesSummary(sql: postgres.Sql, workspaceId: string): Promise<DatatypeSummary> {
  const rows = await sql<{ tier: string; review_status: string; published: boolean; n: number }[]>`
    SELECT tier, review_status, published, count(*)::int AS n
      FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active'
     GROUP BY tier, review_status, published`;
  const byTier: Record<string, number> = {};
  const byReviewStatus: Record<string, number> = {};
  let total = 0;
  let published = 0;
  for (const r of rows) {
    total += r.n;
    byTier[r.tier] = (byTier[r.tier] ?? 0) + r.n;
    byReviewStatus[r.review_status] = (byReviewStatus[r.review_status] ?? 0) + r.n;
    if (r.published) published += r.n;
  }
  return { total, byTier, byReviewStatus, published };
}

export interface SimilarDatatype {
  id: string;
  title: string;
  description: string;
  tier: DatatypeTier;
  /**
   * A RANKING weight — NOT a calibrated similarity, and NEVER safe to threshold (EI-10562).
   * It is `GREATEST(ts_rank, 0.4*ts_rank + 0.6*cosine)`: a weighted sum of two quantities on
   * different scales, so a constant compared against it has no stable meaning. (This field's
   * doc used to claim "0..1", and a consumer duly wrote `score >= 0.05` to REFUSE — which is
   * cosine >= 0.083, the noise floor, and refused 100% of legitimate declarations.)
   *
   * Use it to ORDER candidates. To DECIDE duplicate-or-not, use {@link canonicalDatatypeKey}.
   */
  score: number;
}

/**
 * The ADVISORY neighbour surface at declaration (D-010): the existing datatypes nearest
 * the one being declared, strongest first, so the caller can be TOLD "you declared
 * `orders`; `order` already exists — if you meant that one, retire yours."
 *
 * ADVISORY, not a gate (EI-10562). These results rank; they do not judge. The refusal
 * path is {@link findCanonicalDuplicate}, an exact test. Lexical leg (title_tsv over
 * title+description) is embedder-independent; an `embedding` fuses the cosine leg in.
 */
export async function findSimilarDatatypes(
  sql: postgres.Sql,
  workspaceId: string,
  q: {
    title: string;
    description?: string;
    embedding?: number[] | null;
    embeddingProfile?: ProseProfileSelection | null;
    excludeId?: string;
    limit?: number;
  },
): Promise<SimilarDatatype[]> {
  // OR semantics (any shared keyword is a dedup candidate, ranked by ts_rank) — NOT
  // websearch_to_tsquery, which ANDs the words and would miss near-duplicates that
  // share only some terms. Sanitize to alphanumeric tokens (len≥2 drops 'a'/noise)
  // and join with ' | '; the english config stems + drops stopwords.
  const tokens = `${q.title} ${q.description ?? ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const orQuery = tokens.join(' | ');
  const lim = Math.max(1, Math.min(20, q.limit ?? 5));
  const embeddingLiteral =
    q.embedding && q.embedding.length > 0 ? `[${q.embedding.join(',')}]` : null;
  if (embeddingLiteral && !q.embeddingProfile) {
    throw new Error('findSimilarDatatypes: a query embedding requires exact profile provenance');
  }
  const exclude = q.excludeId ? sql`AND id <> ${q.excludeId}` : sql``;
  // ts_rank for the lexical leg; when an embedding is present, fuse (1 - cosine distance)
  // in 60/40 favour of the vector — the same two-leg shape code_recipes dedup uses.
  const rows = await sql<{ id: string; title: string; description: string; tier: string; score: number }[]>`
    SELECT id, title, description, tier,
      ${
        embeddingLiteral
          ? sql`GREATEST(
                  ts_rank(title_tsv, to_tsquery('english', ${orQuery})),
                  CASE WHEN embedding IS NULL
                          OR NOT (${proseProfilePredicateSql(sql, q.embeddingProfile ?? null, 'embedding_profile', 'embedding_mode')})
                       THEN 0
                       ELSE 0.4 * ts_rank(title_tsv, to_tsquery('english', ${orQuery}))
                            + 0.6 * (1 - (embedding <=> ${embeddingLiteral}::vector)) END
                )`
          : sql`ts_rank(title_tsv, to_tsquery('english', ${orQuery}))`
      } AS score
      FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active' ${exclude}
       AND (
         title_tsv @@ to_tsquery('english', ${orQuery})
         ${embeddingLiteral
           ? sql`OR (embedding IS NOT NULL AND ${proseProfilePredicateSql(sql, q.embeddingProfile ?? null, 'embedding_profile', 'embedding_mode')})`
           : sql``}
       )
     ORDER BY score DESC
     LIMIT ${lim}`;
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      tier: (isDatatypeTier(r.tier) ? r.tier : 'generic-kind') as DatatypeTier,
      score: Number(r.score) || 0,
    }))
    .filter((r) => r.score > 0);
}

/**
 * Is `kind` a registered generic-kind datatype in this workspace? The gate
 * work_items:create consults to accept a runtime-registered kind alongside the
 * built-in WORK_ITEM_KINDS (P-001 generic-kind tier).
 */
export async function hasGenericKind(
  sql: postgres.Sql,
  workspaceId: string,
  kind: string,
): Promise<boolean> {
  if (!kind) return false;
  const rows = await sql<{ ok: boolean }[]>`
    SELECT TRUE AS ok FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active'
       AND tier = 'generic-kind' AND work_item_kind = ${kind}
     LIMIT 1`;
  return Boolean(rows[0]?.ok);
}

/**
 * Fetch the active generic-kind datatype registered under `kind` (its `work_item_kind`)
 * in this workspace — the row work_items:create needs to VALIDATE an instance payload
 * against `payloadSchema` (P-001). Null when the kind is not a registered generic-kind.
 * A superset of {@link hasGenericKind} (presence) that also returns the schema.
 */
export async function getGenericKindDatatype(
  sql: postgres.Sql,
  workspaceId: string,
  kind: string,
): Promise<DatatypeRow | null> {
  if (!kind) return null;
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active'
       AND tier = 'generic-kind' AND work_item_kind = ${kind}
     LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * The registered generic-kind datatype names for a workspace — feeds the blueprint
 * dependency resolver's `availableDatatypes` host set (P-012) and the work_items
 * kind gate (P-001). Returns the datatype ids (the names blueprints reference).
 */
export async function listRegisteredDatatypeNames(
  sql: postgres.Sql,
  workspaceId: string,
): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.datatype_registry
     WHERE workspace_id = ${workspaceId} AND status = 'active'`;
  return rows.map((r) => r.id);
}

// ── D-010 shared/published tier (migration 425) ──────────────────────────────────────────
// A datatype's LOCAL `status` is untouched by publishing (it stays usable in its workspace);
// `review_status` is the SEPARATE global-tier gate: none → pending → approved | rejected.

/**
 * Mark a workspace-local datatype as PUBLISHED + PENDING moderation (the publish INTENT).
 * Only a not-yet-published ('none') row transitions; returns the updated row, or null when
 * absent / already in a publish lifecycle. Workspace-scoped (the owning workspace publishes).
 */
export async function publishDatatype(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
): Promise<DatatypeRow | null> {
  const rows = await sql<DbRow[]>`
    UPDATE harness_shared.datatype_registry
       SET published = true, review_status = 'pending', updated_at = now()
     WHERE workspace_id = ${workspaceId} AND id = ${id} AND review_status = 'none'
    RETURNING ${SELECT_COLS(sql)}`;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * The operator moderation QUEUE — published datatypes awaiting review, across ALL workspaces.
 * Needs a cross-workspace (RLS-bypass / admin) handle; an org-scoped handle sees only its own
 * workspace. Newest first.
 */
export async function listPendingPublishedDatatypes(
  sql: postgres.Sql,
  opts: { limit?: number } = {},
): Promise<DatatypeRow[]> {
  const lim = clampLimit(opts.limit);
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.datatype_registry
     WHERE review_status = 'pending'
     ORDER BY updated_at DESC, id
     LIMIT ${lim}`;
  return rows.map(mapRow);
}

/**
 * Moderate a pending published datatype: `approve` → 'approved' (globally visible),
 * `reject` → 'rejected'. Only a 'pending' row transitions (idempotent re-moderation is a
 * no-op → null). Returns the updated row or null.
 */
export async function moderatePublishedDatatype(
  sql: postgres.Sql,
  workspaceId: string,
  id: string,
  decision: 'approve' | 'reject',
): Promise<DatatypeRow | null> {
  const next = decision === 'approve' ? 'approved' : 'rejected';
  const rows = await sql<DbRow[]>`
    UPDATE harness_shared.datatype_registry
       SET review_status = ${next}, updated_at = now()
     WHERE workspace_id = ${workspaceId} AND id = ${id} AND review_status = 'pending'
    RETURNING ${SELECT_COLS(sql)}`;
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * D-010 GLOBAL semantic dedup: existing PUBLISHED datatypes (pending or approved) across ALL
 * workspaces that look like the one being published — so the published namespace stays
 * globally coherent. The same lexical+cosine surface as {@link findSimilarDatatypes}, but
 * GLOBAL (no workspace filter) and scoped to `review_status IN ('pending','approved')`. Needs
 * a cross-workspace (admin/RLS-bypass) handle — the server moderation path's primitive.
 */
export async function findSimilarPublishedDatatypes(
  sql: postgres.Sql,
  q: { title: string; description?: string; embedding?: number[] | null; excludeId?: string; limit?: number },
): Promise<SimilarDatatype[]> {
  const tokens = `${q.title} ${q.description ?? ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  const orQuery = tokens.join(' | ');
  const lim = Math.max(1, Math.min(20, q.limit ?? 5));
  const embeddingLiteral = q.embedding && q.embedding.length > 0 ? `[${q.embedding.join(',')}]` : null;
  const exclude = q.excludeId ? sql`AND id <> ${q.excludeId}` : sql``;
  const rows = await sql<{ id: string; title: string; description: string; tier: string; score: number }[]>`
    SELECT id, title, description, tier,
      ${
        embeddingLiteral
          ? sql`GREATEST(
                  ts_rank(title_tsv, to_tsquery('english', ${orQuery})),
                  CASE WHEN embedding IS NULL THEN 0
                       ELSE 0.4 * ts_rank(title_tsv, to_tsquery('english', ${orQuery}))
                            + 0.6 * (1 - (embedding <=> ${embeddingLiteral}::vector)) END
                )`
          : sql`ts_rank(title_tsv, to_tsquery('english', ${orQuery}))`
      } AS score
      FROM harness_shared.datatype_registry
     WHERE review_status IN ('pending', 'approved') ${exclude}
       AND (
         title_tsv @@ to_tsquery('english', ${orQuery})
         ${embeddingLiteral ? sql`OR embedding IS NOT NULL` : sql``}
       )
     ORDER BY score DESC
     LIMIT ${lim}`;
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      tier: (isDatatypeTier(r.tier) ? r.tier : 'generic-kind') as DatatypeTier,
      score: Number(r.score) || 0,
    }))
    .filter((r) => r.score > 0);
}

/**
 * D-010 distribution: the GLOBAL catalog of APPROVED published datatypes (the shared tier),
 * across all workspaces. Needs a cross-workspace (admin/RLS-bypass) handle. Newest first.
 */
export async function listApprovedPublishedDatatypes(
  sql: postgres.Sql,
  opts: { limit?: number } = {},
): Promise<DatatypeRow[]> {
  const lim = clampLimit(opts.limit);
  const rows = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.datatype_registry
     WHERE review_status = 'approved'
     ORDER BY updated_at DESC, id
     LIMIT ${lim}`;
  return rows.map(mapRow);
}

export type InstallPublishedResult =
  | { ok: true; datatype: DatatypeRow }
  | { ok: false; reason: 'not_found' | 'already_present' };

/**
 * D-010 distribution: install an APPROVED published datatype into `targetWorkspaceId` — copies
 * its definition (title/description/tier/work_item_kind/payload_schema/display/self_improvement/tags) as
 * a LOCAL datatype there (review_status resets to the insert default 'none', `published` false),
 * so the target uses it like a locally-declared one. Idempotent: a datatype already present under
 * that id in the target is left untouched (`already_present`). Cross-workspace ⇒ needs an
 * admin/RLS-bypass handle to read the global source.
 */
export async function installPublishedDatatype(
  sql: postgres.Sql,
  id: string,
  targetWorkspaceId: string,
): Promise<InstallPublishedResult> {
  const src = await sql<DbRow[]>`
    SELECT ${SELECT_COLS(sql)} FROM harness_shared.datatype_registry
     WHERE id = ${id} AND review_status = 'approved'
     LIMIT 1`;
  if (!src[0]) return { ok: false, reason: 'not_found' };
  if (await getDatatype(sql, targetWorkspaceId, id)) return { ok: false, reason: 'already_present' };
  const s = mapRow(src[0]);
  const row = await upsertDatatype(sql, {
    id: s.id,
    workspaceId: targetWorkspaceId,
    potSlug: null,
    title: s.title,
    description: s.description,
    tier: s.tier,
    workItemKind: s.workItemKind,
    nature: s.nature,
    audience: s.audience,
    payloadSchema: s.payloadSchema,
    display: s.display,
    authoritativeWriter: s.authoritativeWriter,
    selfImprovement: s.selfImprovement,
    published: false,
    tags: s.tags,
    embedding: null, // re-embedded locally on next declare if wanted; the vector is not copied
    createdBy: null,
  });
  return { ok: true, datatype: row };
}
