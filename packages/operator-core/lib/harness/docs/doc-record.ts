/**
 * doc-record — typed read/write over harness_shared.harness_docs (mig 172).
 *
 * Plan: harness-docs-integration-2026-06-05 (P-002 / D-002 / D-007). PG is the
 * runtime store-of-record for the doc RECORD (metadata + augmented overlay +
 * derived freshness); the doc BODY stays a repo file (git sync authority). This
 * module is the only place that touches the table — every other layer (provenance
 * capture P-004, overlay P-005, manual anchoring P-006, the freshness sweep P-003,
 * the merged read P-007) goes through these helpers.
 *
 * Admin pool (getOrgPg, BYPASSRLS) + explicit workspace_id filter, mirroring the
 * harness_plans access pattern.
 *
 * `source` is kept consistent with the overlay automatically (D-003): a record
 * with a non-null overlay is ALWAYS `augmented`; without one it's `generated`
 * (when it has a generated_from_sha baseline) or `manual`. So a documenter
 * regeneration of an overlaid doc preserves both the overlay AND the augmented
 * source — it never silently downgrades to plain generated.
 */

import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { resolveWorkspaceForHarness } from '../workspace-for-harness';
import { deriveFrontmatterIndex, sha256 } from './authored-doc-projection';
import type { SubjectRef } from './subject-ref';
import { guideAddressProblems, type GuideAddressVocabulary } from '../../doc-projection/guide-address';

export type DocSource = 'generated' | 'manual' | 'augmented';
export type DocStatus = 'fresh' | 'stale' | 'review' | 'untracked' | 'unknown';

export type DocPartKind = 'invariant' | 'pointer' | 'recipe' | 'prose';

export interface HarnessDocPart {
  workspaceId: string;
  harnessSlug: string;
  docId: string;
  partKey: string;
  kind: DocPartKind;
  body: string;
  ordinal: number;
  tombstone: boolean;
  origin: string;
  author: string | null;
  fedTs: number;
  fedHlc: string | null;
  createdAt: number;
  updatedAt: number;
  clientScope: string[];
  projectRank: number;
  targetSection: string | null;
  rationalePartKey: string | null;
}

export interface SetDocPartInput {
  harnessSlug: string;
  docId: string;
  partKey: string;
  workspaceId?: string;
  kind?: DocPartKind;
  body?: string;
  ordinal?: number;
  tombstone?: boolean;
  author?: string | null;
  clientScope?: string[];
  projectRank?: number;
  targetSection?: string | null;
  rationalePartKey?: string | null;
  /** P-022 addressing tokens (`blueprint:<id>` / `slot:<slot>` / `role:<role>`); empty = unaddressed. */
  stackScope?: string[];
}

export interface DocPartValidationInput {
  partKey: string;
  kind: string;
  clientScope: readonly string[];
  targetSection: string | null;
  rationalePartKey: string | null;
  /**
   * P-022: the part's addressing declaration. Optional so every pre-P-022 caller
   * validates exactly as before; when present it is checked against migration 1104's
   * two CHECKs (addressed ⇒ projects; token shape) plus the supplied vocabulary.
   */
  stackScope?: readonly string[];
  /** Vocabulary for the token check — registered slot ids, blueprint existence. */
  stackVocabulary?: GuideAddressVocabulary;
}

/** The body and persisted columns that make up a doc-part's effective value. */
export interface DocPartComparable {
  body: string;
  kind: string;
  ordinal: number;
  clientScope: readonly string[];
  projectRank: number;
  targetSection: string | null;
  rationalePartKey: string | null;
  /** P-022 addressing tokens; omitted on both sides compares as unaddressed. */
  stackScope?: readonly string[];
}

/**
 * Whether an attempted set-doc-part write changes anything on the row.
 *
 * A body-only comparison is insufficient: callers are explicitly allowed to
 * reprioritize an unchanged body (for example, to move a rule back into a
 * client's budget). Keep this pure so the CLI's no-op guard and its regression
 * tests share the same comparison semantics.
 */
export function docPartHasChanges(before: DocPartComparable, after: DocPartComparable): boolean {
  const beforeStack = before.stackScope ?? [];
  const afterStack = after.stackScope ?? [];
  return (
    before.body !== after.body ||
    before.kind !== after.kind ||
    before.ordinal !== after.ordinal ||
    before.projectRank !== after.projectRank ||
    before.targetSection !== after.targetSection ||
    before.rationalePartKey !== after.rationalePartKey ||
    before.clientScope.length !== after.clientScope.length ||
    before.clientScope.some((scope, index) => scope !== after.clientScope[index]) ||
    beforeStack.length !== afterStack.length ||
    beforeStack.some((token, index) => token !== afterStack[index])
  );
}

/**
 * Mirror every CHECK on migration 781's harness_doc_parts table before the write.
 * Keeping this pure makes the safety rail testable without a live database and
 * turns a database constraint failure into a useful per-item tool error.
 */
export function validateDocPart(input: DocPartValidationInput): string | null {
  if (!['invariant', 'pointer', 'recipe', 'prose'].includes(input.kind)) {
    return `${input.partKey}: kind must be one of invariant, pointer, recipe, prose`;
  }
  if (input.clientScope.length > 0 && input.targetSection === null) {
    return `${input.partKey}: projected parts require targetSection`;
  }
  if (input.rationalePartKey !== null && input.kind !== 'recipe') {
    return `${input.partKey}: rationalePartKey is only valid for recipe parts`;
  }
  if (input.kind === 'prose' && input.clientScope.length > 0) {
    return `${input.partKey}: prose parts cannot project to a client`;
  }
  // P-022 (migration 1104): an addressed part must project somewhere, and every token
  // must be an address the launch seat can ever match.
  const stackScope = input.stackScope ?? [];
  if (stackScope.length > 0 && input.clientScope.length === 0) {
    return `${input.partKey}: an addressed part (stack_scope set) must also project to a client (client_scope empty)`;
  }
  const addressProblems = guideAddressProblems(stackScope, input.stackVocabulary);
  if (addressProblems.length > 0) {
    return `${input.partKey}: stack_scope ${addressProblems.join('; ')}`;
  }
  return null;
}

export interface HarnessDocRecord {
  workspaceId: string;
  harnessSlug: string;
  docId: string;
  source: DocSource;
  subjectRef: SubjectRef[];
  anchorPaths: string[];
  generatedFromSha: string | null;
  lastVerifiedSha: string | null;
  lastVerifiedAt: string | null;
  overlay: string | null;
  status: DocStatus;
  statusDetail: string | null;
  statusCheckedAt: string | null;
  regenEnqueuedAt: string | null;
  reverifyFlaggedAt: string | null;
  /** Doc-steward dispatches in the CURRENT unhealed episode (reset to 0 on heal).
   *  Drives the backoff + give-up cap in the freshness sweep (mig 386). */
  regenAttempts: number;
  reverifyAttempts: number;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DocRow {
  workspace_id: string;
  harness_slug: string;
  doc_id: string;
  source: string;
  subject_ref: unknown;
  anchor_paths: string[];
  generated_from_sha: string | null;
  last_verified_sha: string | null;
  last_verified_at: Date | string | null;
  overlay: string | null;
  status: string;
  status_detail: string | null;
  status_checked_at: Date | string | null;
  regen_enqueued_at: Date | string | null;
  reverify_flagged_at: Date | string | null;
  regen_attempts: number | null;
  reverify_attempts: number | null;
  title: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const toIso = (v: Date | string | null): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

function rowToRecord(r: DocRow): HarnessDocRecord {
  const refs = Array.isArray(r.subject_ref) ? (r.subject_ref as SubjectRef[]) : [];
  return {
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    docId: r.doc_id,
    source: (r.source as DocSource) ?? 'manual',
    subjectRef: refs,
    anchorPaths: r.anchor_paths ?? [],
    generatedFromSha: r.generated_from_sha,
    lastVerifiedSha: r.last_verified_sha,
    lastVerifiedAt: toIso(r.last_verified_at),
    overlay: r.overlay,
    status: (r.status as DocStatus) ?? 'untracked',
    statusDetail: r.status_detail,
    statusCheckedAt: toIso(r.status_checked_at),
    regenEnqueuedAt: toIso(r.regen_enqueued_at),
    reverifyFlaggedAt: toIso(r.reverify_flagged_at),
    regenAttempts: r.regen_attempts ?? 0,
    reverifyAttempts: r.reverify_attempts ?? 0,
    title: r.title,
    createdAt: toIso(r.created_at) ?? '',
    updatedAt: toIso(r.updated_at) ?? '',
  };
}

/** One doc record, or null if none. */
export async function getDocRecord(
  harnessSlug: string,
  docId: string,
  workspaceId?: string,
): Promise<HarnessDocRecord | null> {
  // Derive the workspace from the harness (a harness's docs live in its workspace) —
  // never a silent 'default' for an omitted scope (P-002 docs sub-part / D-003).
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  const rows = await sql<DocRow[]>`
    SELECT * FROM harness_shared.harness_docs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}
     LIMIT 1`;
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/** Canonical authored prose for one doc, or null when absent/unpopulated. */
export async function getAuthoredDocContent(
  harnessSlug: string,
  docId: string,
  workspaceId?: string,
): Promise<string | null> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  const rows = await sql<{ content: string | null }[]>`
    SELECT content FROM harness_shared.harness_docs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}
     LIMIT 1`;
  return typeof rows[0]?.content === 'string' && rows[0].content.length > 0 ? rows[0].content : null;
}

/**
 * Canonical authored prose for a bounded set of exact doc ids.
 *
 * `docs:get` uses this targeted form for read-after-write correctness across
 * operator workers. Each request asks for at most ten slugs (twenty `.md` /
 * `.mdx` candidates), so refreshing those rows is both cheaper and more precise
 * than discarding the process-wide adapter and re-reading the whole corpus.
 */
export async function getAuthoredDocContentsByIds(
  harnessSlug: string,
  docIds: readonly string[],
  workspaceId?: string,
): Promise<Map<string, string>> {
  const requested = [...new Set(docIds.filter((docId) => docId.length > 0))];
  if (requested.length === 0) return new Map();
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  const rows = await sql<{ doc_id: string; content: string | null }[]>`
    SELECT doc_id, content FROM harness_shared.harness_docs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND doc_id = ANY(${requested}::text[])
       AND content IS NOT NULL AND content <> ''`;
  const out = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.content === 'string' && row.content.length > 0) out.set(row.doc_id, row.content);
  }
  return out;
}

/**
 * Canonical authored prose for every populated doc in a harness, keyed by doc id.
 *
 * Read surfaces use this bulk form when they need to overlay the filesystem
 * projection. One query matters here: docs:get/outline/search may all run before
 * git-sync has projected a newly authored page into the checkout the operator is
 * serving, so fetching one row at a time would turn a correctness repair into an
 * N+1 database read on every cold adapter load.
 */
export async function listAuthoredDocContents(harnessSlug: string, workspaceId?: string): Promise<Map<string, string>> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  const rows = await sql<{ doc_id: string; content: string | null }[]>`
    SELECT doc_id, content FROM harness_shared.harness_docs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND content IS NOT NULL AND content <> ''`;
  const out = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.content === 'string' && row.content.length > 0) out.set(row.doc_id, row.content);
  }
  return out;
}

/** All doc records for a harness, keyed by doc_id. */
export async function listDocRecords(
  harnessSlug: string,
  workspaceId?: string,
): Promise<Map<string, HarnessDocRecord>> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  const rows = await sql<DocRow[]>`
    SELECT * FROM harness_shared.harness_docs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}`;
  const out = new Map<string, HarnessDocRecord>();
  for (const r of rows) out.set(r.doc_id, rowToRecord(r));
  return out;
}

export interface UpsertDocInput {
  harnessSlug: string;
  docId: string;
  workspaceId?: string;
  /** 'manual' or 'generated' — the BASE nature. The stored source upgrades to
   *  'augmented' automatically whenever an overlay is present. */
  source: DocSource;
  subjectRef: SubjectRef[];
  anchorPaths: string[];
  generatedFromSha?: string | null;
  lastVerifiedSha?: string | null;
  lastVerifiedAt?: string | null;
  /** Only set on a fresh insert; an upsert over an existing row NEVER changes the
   *  overlay (use setDocOverlay) so a regeneration preserves the human overlay. */
  overlay?: string | null;
  status?: DocStatus;
  statusDetail?: string | null;
  title?: string | null;
  /**
   * The doc's canonical prose — the WHOLE .mdx text, frontmatter included (P-008 / D-025).
   *
   * PG is canonical for authored docs and the .mdx file is a projection of THIS value, so
   * `content` is the authored source and not a cache of the file. `content_hash` and the
   * `frontmatter` index are DERIVED here rather than accepted from the caller, because a
   * caller that updated one and forgot the others is how the three silently disagree.
   *
   * OMIT to leave existing prose untouched. That is the common case: most callers of this
   * writer (the anchor path, the freshness sweep, the doc-steward) are updating METADATA
   * and hold no opinion about the body — and a metadata upsert that blanked the prose
   * would be catastrophic, so an absent `content` must mean "unchanged", never "empty".
   */
  content?: string | null;
}

// `sha256` and `deriveFrontmatterIndex` come from ./authored-doc-projection, which is also
// what the CLI projector and docs:author use. One definition, deliberately: if this writer
// derived the index differently from the projector, the same doc would carry a different
// `frontmatter` depending on which path last wrote it, and neither would be wrong-looking.

/**
 * Insert or update a doc record (PK conflict on workspace+harness+doc_id).
 *
 * Overlay preservation (D-003/P-005): on conflict the overlay is NEVER touched
 * here — a documenter regeneration that re-upserts a generated doc keeps any human
 * overlay intact, and the stored source stays 'augmented' while the overlay lives.
 */
export async function upsertDocRecord(input: UpsertDocInput): Promise<HarnessDocRecord> {
  const ws = await resolveWorkspaceForHarness(input.harnessSlug, input.workspaceId);
  const base: 'manual' | 'generated' = input.source === 'manual' ? 'manual' : 'generated';
  const insertOverlay = input.overlay ?? null;
  // null (not '') when absent, so the SQL below can distinguish "leave the prose alone"
  // from "the prose is empty". The column is NOT NULL DEFAULT '', hence the COALESCE on
  // insert and the parameter-vs-column COALESCE on conflict.
  const content = input.content ?? null;
  const contentHash = content === null ? null : sha256(content);
  const frontmatter = content === null ? null : deriveFrontmatterIndex(content);
  const frontmatterJson = frontmatter === null ? null : JSON.stringify(frontmatter);
  const { sql } = getOrgPg();
  const rows = await sql<DocRow[]>`
    INSERT INTO harness_shared.harness_docs
      (workspace_id, harness_slug, doc_id, source, subject_ref, anchor_paths,
       generated_from_sha, last_verified_sha, last_verified_at, overlay,
       status, status_detail, status_checked_at, title,
       content, content_hash, frontmatter)
    VALUES (
      ${ws}, ${input.harnessSlug}, ${input.docId},
      ${insertOverlay !== null ? 'augmented' : base},
      ${JSON.stringify(input.subjectRef ?? [])}::text::jsonb,
      ${input.anchorPaths ?? []}::text[],
      ${input.generatedFromSha ?? null}, ${input.lastVerifiedSha ?? null}, ${input.lastVerifiedAt ?? null},
      ${insertOverlay},
      ${input.status ?? 'untracked'}, ${input.statusDetail ?? null}, now(), ${input.title ?? null},
      COALESCE(${content}::text, ''), COALESCE(${contentHash}::text, ''), ${frontmatterJson}::jsonb
    )
    ON CONFLICT (workspace_id, harness_slug, doc_id) DO UPDATE SET
      source = CASE WHEN harness_shared.harness_docs.overlay IS NOT NULL THEN 'augmented' ELSE ${base} END,
      subject_ref = EXCLUDED.subject_ref,
      anchor_paths = EXCLUDED.anchor_paths,
      generated_from_sha = EXCLUDED.generated_from_sha,
      last_verified_sha = COALESCE(EXCLUDED.last_verified_sha, harness_shared.harness_docs.last_verified_sha),
      last_verified_at = COALESCE(EXCLUDED.last_verified_at, harness_shared.harness_docs.last_verified_at),
      status = EXCLUDED.status,
      status_detail = EXCLUDED.status_detail,
      status_checked_at = now(),
      title = COALESCE(EXCLUDED.title, harness_shared.harness_docs.title),
      -- Prose, and the two values derived from it. Two guards, both deliberate:
      --
      --   1. COALESCE on the PARAMETER, not on EXCLUDED. EXCLUDED.content is the
      --      already-defaulted empty string from the INSERT list above, so keying off it
      --      would blank the prose on every metadata-only upsert -- the catastrophic
      --      reading of "absent".
      --   2. A composed row is NEVER touched. For those docs harness_doc_parts is
      --      canonical and the content column is scripts/project-doc-parts.mjs's cached
      --      output (D-010); letting a metadata upsert write prose there would corrupt
      --      the cache that projector's overwrite guard trusts to recognise its own
      --      output. This writer only ever authors the authored side of that split.
      content = CASE WHEN harness_shared.harness_docs.content_mode = 'composed'
                     THEN harness_shared.harness_docs.content
                     ELSE COALESCE(${content}::text, harness_shared.harness_docs.content) END,
      content_hash = CASE WHEN harness_shared.harness_docs.content_mode = 'composed'
                     THEN harness_shared.harness_docs.content_hash
                     ELSE COALESCE(${contentHash}::text, harness_shared.harness_docs.content_hash) END,
      frontmatter = CASE WHEN harness_shared.harness_docs.content_mode = 'composed'
                     THEN harness_shared.harness_docs.frontmatter
                     ELSE COALESCE(${frontmatterJson}::jsonb, harness_shared.harness_docs.frontmatter) END
    RETURNING *`;
  return rowToRecord(rows[0]);
}

/** Flip the derived freshness cache (the sweep / on-demand recompute write here). */
export async function setDocStatus(
  harnessSlug: string,
  docId: string,
  status: DocStatus,
  statusDetail: string | null = null,
  workspaceId?: string,
): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  // Heal resets the episode bookkeeping (mig 386): when a doc returns to `fresh`
  // (the baseline caught up — a documenter regen advanced generated_from_sha, or a
  // verify advanced last_verified_sha), clear the dispatch latch + attempt counter
  // so a FUTURE drift re-dispatches the doc-steward instead of being suppressed by
  // a stale latch left over from the previous episode (the regen latch was never
  // cleared at all before this — generated docs silently stopped re-dispatching).
  await sql`
    UPDATE harness_shared.harness_docs
       SET status = ${status}, status_detail = ${statusDetail}, status_checked_at = now(),
           regen_enqueued_at = CASE WHEN ${status} = 'fresh' THEN NULL ELSE regen_enqueued_at END,
           reverify_flagged_at = CASE WHEN ${status} = 'fresh' THEN NULL ELSE reverify_flagged_at END,
           regen_attempts = CASE WHEN ${status} = 'fresh' THEN 0 ELSE regen_attempts END,
           reverify_attempts = CASE WHEN ${status} = 'fresh' THEN 0 ELSE reverify_attempts END
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

/** A human verified a manual doc against the current HEAD → fresh + new baseline. */
export async function verifyDoc(
  harnessSlug: string,
  docId: string,
  verifiedSha: string,
  workspaceId?: string,
): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET last_verified_sha = ${verifiedSha}, last_verified_at = now(),
           status = 'fresh', status_detail = NULL, status_checked_at = now(),
           reverify_flagged_at = NULL, reverify_attempts = 0
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

/**
 * Set/replace the augmented overlay (P-005). The stored source follows: with an
 * overlay → 'augmented'; cleared → 'generated' if it has a generated baseline,
 * else 'manual'.
 */
export async function setDocOverlay(
  harnessSlug: string,
  docId: string,
  overlay: string | null,
  workspaceId?: string,
): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET overlay = ${overlay},
           source = CASE
             WHEN ${overlay}::text IS NOT NULL THEN 'augmented'
             WHEN generated_from_sha IS NOT NULL THEN 'generated'
             ELSE 'manual' END
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

/** Record that a regeneration was dispatched (D-004): bump the latch timestamp AND
 *  the per-episode attempt counter (mig 386). The sweep keys its backoff/give-up off
 *  both — `regen_enqueued_at` is the retry clock, `regen_attempts` the cap counter. */
export async function markRegenEnqueued(harnessSlug: string, docId: string, workspaceId?: string): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET regen_enqueued_at = now(), regen_attempts = regen_attempts + 1
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

/** Record that a re-verify (doc-steward) dispatch fired (D-004): bump latch + attempt
 *  counter (mig 386), same retry-clock/cap model as markRegenEnqueued. */
export async function markReverifyFlagged(harnessSlug: string, docId: string, workspaceId?: string): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET reverify_flagged_at = now(), reverify_attempts = reverify_attempts + 1
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

// ── WI-1661: latch-only touches (no attempt spend) ──────────────────────────────
// The freshness sweep (freshness-sweep.ts) needs to re-pace how often it re-considers
// a still-drifted doc for the dispatch batch (the retry BACKOFF clock) WITHOUT
// spending one of the doc's 5 give-up attempts — an attempt should only be spent once
// a doc-steward is CONFIRMED to have actually launched for it (sweep-after-sync.ts
// calls markRegenEnqueued/markReverifyFlagged above for that). Touching only the latch
// timestamp keeps the backoff cadence (30min → ... → 6h) intact — so a congested sweep
// doesn't re-batch the same doc every tick — without inflating the attempt counter.

/** Touch ONLY the regen retry-clock (no attempt spent). See the WI-1661 note above. */
export async function touchRegenLatch(harnessSlug: string, docId: string, workspaceId?: string): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET regen_enqueued_at = now()
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

/** Touch ONLY the reverify retry-clock (no attempt spent). See the WI-1661 note above. */
export async function touchReverifyLatch(harnessSlug: string, docId: string, workspaceId?: string): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.harness_docs
       SET reverify_flagged_at = now()
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}

export async function deleteDocRecord(harnessSlug: string, docId: string, workspaceId?: string): Promise<void> {
  workspaceId = await resolveWorkspaceForHarness(harnessSlug, workspaceId);
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.harness_docs
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND doc_id = ${docId}`;
}
