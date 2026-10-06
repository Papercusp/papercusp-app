/**
 * candidates — the fleet→pack candidate staging area
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11; auto-adopt
 * reversal owner-auto-adopt-fleet-lessons-2026-07-19 / WI-5414).
 *
 * The recurrence-escalation cross-scope promotion (P-052 lite) notices a
 * friction signature recurring across ≥2 DISTINCT scopes — cross-Hive pain
 * that belongs in the shared knowledge layer. This module is the missing edge
 * from that observation into the knowledge-pack system:
 *
 *   stage    one CANDIDATE row per signature (PG, migration 239; GLOBAL since 377)
 *            with full provenance — deduped structurally (UNIQUE signature — a
 *            learning is a workspace-agnostic capability, data-scoping-audit P-002,
 *            so a dismissed lesson never re-nags) and capped (pending ≤
 *            {@link pendingCandidateCap}), like the lite promotion itself.
 *   list     the Learnings view + knowledge_packs:candidates read.
 *   review   {@link reviewCandidateForAutoAdopt} — the AUTOMATED review (WI-5414
 *            reverses the old owner-gate contract: "the whole point of the
 *            learnings tab is that the things there do NOT need human
 *            supervision"). TWO stages (knowledge-pack-loop-integrity P-001):
 *            (1) a TRANSFERABILITY judge/distiller (./candidate-review) that
 *            rejects raw incident bodies and REWRITES a passing draft into the
 *            compact transferable lesson the pack will actually carry; (2) the
 *            EXISTING knowledge-pack sweep-scoring machinery
 *            (memory/conflict-check.ts, as manage.ts's install/upgrade review
 *            and sweepHiveConflicts already run) — the DISTILLED lesson is
 *            judged against the fleet-lessons pack's OWN current items; a
 *            reported contradiction fails review. An errored judge yields
 *            verdict 'error': the candidate STAYS PENDING for the next tick
 *            (plan D-004 — never adopt-by-default).
 *   decide   adopt or dismiss. Adoption materializes the item into the
 *            `fleet-lessons` pack under the SHARED workspace-independent packs
 *            root (P-005) and bumps the pack's patch version — it NEVER
 *            touches a hive pool directly.
 *            {@link autoAdoptPendingCandidates} runs the review then calls this
 *            with a MACHINE `by` identity ({@link AUTO_ADOPT_REVIEWER}) on the
 *            improvement-triage cadence — a passing review auto-adopts, a
 *            failing one auto-dismisses with the verdict recorded as the
 *            decision note. The owner can still adopt/dismiss manually at any
 *            time (a race with the sweep is harmless: decide() only acts on a
 *            still-`pending` row). Hives then adopt the new pack item through
 *            the EXISTING install/upgrade conflict review (knowledge-packs
 *            D-003) — which already has its OWN no-human path
 *            (knowledge_packs:upgrade { acceptDefaults: true }), so a hive that
 *            wants hands-off fleet-lessons updates already can without any
 *            further change here.
 *
 * PG layer mirrors scout/routed-ledger.ts (getOrgPg + harness_shared table);
 * the pack-write helpers are exported pure-ish (injectable root) so tests pin
 * them against a temp dir with zero PG.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { sharedKnowledgePacksRoot } from './load-packs';
import {
  APPLIES_TO_SHAPES,
  LEARNING_KINDS,
  memoryTextOf,
  OKF_MANIFEST_KEY,
  OKF_VERSION,
  parseManifest,
  type AppliesTo,
  type LearningKind,
  type KnowledgePackManifest,
} from './pack-format';
import type { LlmJudge } from '../memory/conflict-check';
import type { LessonDistillerLlm } from '../transfer/types';
import {
  judgeCandidateTransferability,
  normalizeCandidateSignature,
  type DistilledCandidate,
} from './candidate-review';
// CandidateStatus, KnowledgePackCandidate, and AUTO_ADOPT_REVIEWER live in the
// CLIENT-SAFE ./candidates-shared so the /adv Learnings view can use them
// without dragging this server module (node:fs/path, PG, sync-sse →
// embedded-pg-discovery) into the browser bundle. Imported for local use here
// and re-exported below so existing importers of this module are unchanged.
import {
  AUTO_ADOPT_REVIEWER,
  FLEET_LESSONS_PACK_ID,
  type CandidateStatus,
  type KnowledgePackCandidate,
} from './candidates-shared';
// P-009 — the pack-admission gate. Enforced at materializeCandidateIntoPack (the
// one chokepoint every adoption path funnels through), so no future caller can
// add an ungated route into a pack.
import {
  checkPackAdmission,
  formatPackResidue,
  resolvePackIdentityEntries,
  type IdentityEntries,
  type PackResidueHit,
} from './pack-residue';
import { trackDetached } from '../detached-imports';

// FLEET_LESSONS_PACK_ID moved to the client-safe ./candidates-shared (P-006);
// re-exported below so existing importers of this module are unchanged.

/** Default pending-candidate cap — staging refuses past it (queue, not landfill). */
export const MAX_PENDING_CANDIDATES = 20;

/**
 * Pending cap: stored settings override (knowledge-pack-settings P-002) →
 * env (PAPERCUSP_LEARNING_CANDIDATE_CAP) → default. `stored` is passed by the
 * async staging path; a bare call keeps the env→default behavior.
 */
export function pendingCandidateCap(stored?: number): number {
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) return Math.floor(stored);
  const raw = Number(process.env.PAPERCUSP_LEARNING_CANDIDATE_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MAX_PENDING_CANDIDATES;
}

// Re-exported from the client-safe ./candidates-shared (imported above) so every
// existing importer of this module keeps resolving CandidateStatus /
// KnowledgePackCandidate / AUTO_ADOPT_REVIEWER unchanged.
export { AUTO_ADOPT_REVIEWER, FLEET_LESSONS_PACK_ID };
export type { CandidateStatus, KnowledgePackCandidate };

interface CandidateRow {
  id: string;
  signature: string;
  title: string;
  draft_text: string;
  kind: string;
  applies_to: unknown;
  scopes: unknown;
  recurrence_count: number;
  source_item_ids: unknown;
  status: string;
  created_by: string;
  created_at: Date | string;
  decided_at: Date | string | null;
  decided_by: string | null;
  decision_note: string | null;
  pack_id: string | null;
  pack_item_id: string | null;
  workspace_id: string | null;
  target_identity_id: string | null;
  target_pack_id: string | null;
  source_memory_id: string | null;
}

function tsToIso(v: Date | string | null): string | undefined {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function rowToCandidate(r: CandidateRow): KnowledgePackCandidate {
  const kind = (LEARNING_KINDS as readonly string[]).includes(r.kind) ? (r.kind as LearningKind) : 'feedback';
  const appliesTo = strArray(r.applies_to).filter((s): s is AppliesTo =>
    (APPLIES_TO_SHAPES as readonly string[]).includes(s),
  );
  return {
    id: r.id,
    signature: r.signature,
    title: r.title,
    draftText: r.draft_text,
    kind,
    appliesTo: appliesTo.length > 0 ? appliesTo : ['any'],
    scopes: strArray(r.scopes),
    recurrenceCount: r.recurrence_count,
    sourceItemIds: strArray(r.source_item_ids),
    status: (['pending', 'adopted', 'dismissed'] as const).find((s) => s === r.status) ?? 'pending',
    createdBy: r.created_by,
    createdAt: tsToIso(r.created_at) ?? new Date(0).toISOString(),
    ...(tsToIso(r.decided_at) ? { decidedAt: tsToIso(r.decided_at) } : {}),
    ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
    ...(r.decision_note ? { decisionNote: r.decision_note } : {}),
    ...(r.pack_id ? { packId: r.pack_id } : {}),
    ...(r.pack_item_id ? { packItemId: r.pack_item_id } : {}),
    ...(r.workspace_id ? { workspaceId: r.workspace_id } : {}),
    ...(r.target_identity_id ? { targetIdentityId: r.target_identity_id } : {}),
    ...(r.target_pack_id ? { targetPackId: r.target_pack_id } : {}),
    ...(r.source_memory_id ? { sourceMemoryId: r.source_memory_id } : {}),
  };
}

function invalidate(names: string[]): void {
  void trackDetached(import('../sync-sse'))
    .then((m) => names.forEach((n) => m.notifySyncInvalidate(n)))
    .catch(() => {});
}

/* ────────────────────────────────────────────────────────────────────────
 * Stage (the recurrence-escalation write)
 * ──────────────────────────────────────────────────────────────────────── */

export interface StageCandidateInput {
  signature: string;
  title: string;
  /** The draft learning body — a starting point the owner reviews/edits. */
  draftText: string;
  scopes: string[];
  recurrenceCount: number;
  sourceItemIds?: string[];
  kind?: LearningKind;
  createdBy?: string;
  identityTarget?: { workspaceId: string; identityId: string; packId: string; memoryId: string };
}

export type StageCandidateResult =
  | { staged: true; id: string }
  | { staged: false; reason: 'duplicate-signature' | 'pending-cap' };

/**
 * File one candidate. Idempotent per signature (ON CONFLICT DO NOTHING on the
 * structural dedup constraint — re-planning the same recurring signature every
 * triage tick is a no-op); refuses past the pending cap so the owner's review
 * queue stays a queue.
 */
export async function stageKnowledgePackCandidate(
  input: StageCandidateInput,
): Promise<StageCandidateResult> {
  const { sql } = getOrgPg();

  if (input.identityTarget) {
    const target = input.identityTarget;
    // A per-target lock makes the cap exact under concurrent explicit proposals.
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify(['identity-candidate', target.workspaceId, target.identityId, target.packId])}))`;
      const existing = await tx`SELECT id FROM harness_shared.knowledge_pack_candidates WHERE signature = ${input.signature}`;
      if (existing.length) return { staged: false as const, reason: 'duplicate-signature' as const };
      const [{ count }] = await tx`SELECT count(*)::text AS count FROM harness_shared.knowledge_pack_candidates
        WHERE status = 'pending' AND workspace_id = ${target.workspaceId}
          AND target_identity_id = ${target.identityId} AND target_pack_id = ${target.packId}`;
      const storedCap = await import('./config').then((m) => m.readKnowledgePackSettings())
        .then((s) => s.pendingCandidateCap).catch(() => undefined);
      if (Number(count) >= pendingCandidateCap(storedCap)) return { staged: false as const, reason: 'pending-cap' as const };
      const rows = await tx`INSERT INTO harness_shared.knowledge_pack_candidates
        (signature, title, draft_text, kind, created_by, workspace_id, target_identity_id, target_pack_id, source_memory_id)
        VALUES (${input.signature}, ${truncateCandidateTitle(input.title)}, ${input.draftText}, ${input.kind ?? 'feedback'},
          ${input.createdBy ?? 'identity-memory'}, ${target.workspaceId}, ${target.identityId}, ${target.packId}, ${target.memoryId})
        ON CONFLICT ON CONSTRAINT knowledge_pack_candidates_signature_uniq DO NOTHING RETURNING id`;
      if (!rows.length) return { staged: false as const, reason: 'duplicate-signature' as const };
      invalidate(['knowledgePacks.candidates']);
      return { staged: true as const, id: String(rows[0]!.id) };
    });
  }

  // Pending cap + structural dedup are GLOBAL now (learnings are workspace-agnostic
  // capabilities, P-002) — the queue is fleet-wide, the signature unique fleet-wide.
  const [{ count }] = await sql<[{ count: string }]>`
    SELECT count(*)::text AS count FROM harness_shared.knowledge_pack_candidates
    WHERE status = 'pending' AND workspace_id IS NULL`;
  // knowledge-pack-settings P-002: the stored cap (memory settings page) wins
  // over the env var; fail-open to env/default if the settings read breaks.
  const storedCap = await import('./config')
    .then((m) => m.readKnowledgePackSettings())
    .then((s) => s.pendingCandidateCap)
    .catch(() => undefined);
  if (Number(count) >= pendingCandidateCap(storedCap)) return { staged: false, reason: 'pending-cap' };

  // knowledge-pack-loop-integrity P-002: dedup on the INSTANCE-STRIPPED
  // signature (log hashes / uuids / bare numbers removed) so one incident
  // CLASS collapses to one candidate. digest.ts recurrence signatures are
  // untouched — normalization happens only at this staging boundary.
  const signature = normalizeCandidateSignature(input.signature);

  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.knowledge_pack_candidates
      (signature, title, draft_text, kind, scopes, recurrence_count,
       source_item_ids, created_by)
    VALUES
      (${signature}, ${truncateCandidateTitle(input.title)}, ${input.draftText},
       ${input.kind ?? 'feedback'}, ${JSON.stringify(input.scopes)}::text::jsonb,
       ${input.recurrenceCount}, ${JSON.stringify(input.sourceItemIds ?? [])}::text::jsonb,
       ${input.createdBy ?? 'recurrence-escalation'})
    ON CONFLICT ON CONSTRAINT knowledge_pack_candidates_signature_uniq DO NOTHING
    RETURNING id`;
  if (rows.length === 0) return { staged: false, reason: 'duplicate-signature' };

  // knowledge-pack-loop-integrity P-003 — the D-006 "inherit-the-bar" edge,
  // previously aspirational (EI-18106972904923204: no writer ever linked a
  // lesson to a candidate, so packCandidateTransferBar could never match).
  // Admit a probationary transfer lesson keyed by lessonSignature(draftText)
  // and linked via pack_candidate_id, so the student-transfer test can gate
  // this candidate's adoption once the transfer harness is armed. Best-effort:
  // staging never fails on the lesson write (the bar itself fails open).
  try {
    const [{ admitTransferLesson }, { lessonSignature }] = await Promise.all([
      import('../transfer/store'),
      import('../transfer/distill'),
    ]);
    await admitTransferLesson(sql, {
      workspaceId: activeWorkspaceId(),
      signature: lessonSignature(input.draftText),
      title: input.title,
      lessonText: input.draftText,
      sourceKind: 'pack-candidate',
      packCandidateId: rows[0]!.id,
    });
  } catch (e) {
    console.warn(
      `[knowledge-packs] transfer-lesson admit failed for candidate ${rows[0]!.id} (best-effort): ${e instanceof Error ? e.message : e}`,
    );
  }

  invalidate(['knowledgePacks.candidates']);
  return { staged: true, id: rows[0]!.id };
}

/* ────────────────────────────────────────────────────────────────────────
 * List
 * ──────────────────────────────────────────────────────────────────────── */

export async function listKnowledgePackCandidates(
  opts: { status?: CandidateStatus; decidedBy?: string; limit?: number; workspaceId?: string; identityId?: string; fleetOnly?: boolean } = {},
): Promise<KnowledgePackCandidate[]> {
  const { sql } = getOrgPg();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const clauses = [
    ...(opts.fleetOnly || !opts.workspaceId ? [sql`workspace_id IS NULL`] : [sql`(workspace_id IS NULL OR workspace_id = ${opts.workspaceId})`]),
    ...(opts.identityId ? [sql`target_identity_id = ${opts.identityId}`] : []),
    ...(opts.status ? [sql`status = ${opts.status}`] : []),
    // `decidedBy` narrows to one decider's calls (e.g. the auto-adopt sweep's
    // machine identity) — the recent-auto-adoptions strip's read (WI-5414).
    ...(opts.decidedBy ? [sql`decided_by = ${opts.decidedBy}`] : []),
  ];
  const where = clauses.length > 0 ? sql`WHERE ${clauses.reduce((a, b) => sql`${a} AND ${b}`)}` : sql``;
  const rows = await sql<CandidateRow[]>`
    SELECT * FROM harness_shared.knowledge_pack_candidates
    ${where}
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return rows.map(rowToCandidate);
}

/* ────────────────────────────────────────────────────────────────────────
 * Pack materialization (pure-ish fs helpers — injectable root for tests)
 * ──────────────────────────────────────────────────────────────────────── */

const FLEET_LESSONS_MANIFEST: KnowledgePackManifest = {
  id: FLEET_LESSONS_PACK_ID,
  title: 'Fleet lessons',
  description:
    'Cross-hive recurring lessons the owner adopted from the fleet’s recurrence-escalation candidates.',
  version: '0.0.0', // bumped to 0.0.1 by the first adoption
  author: 'papercusp-fleet',
  okfVersion: OKF_VERSION,
};

const CANDIDATE_ID_MAX_LEN = 60;

/**
 * Cut a kebab-cased slug to `maxLen` WITHOUT chopping the last word in half
 * (EI-18121665970916886 — a bare `.slice(0, 60)` produced ids ending
 * mid-word, e.g. `…-work-items-prob`). Cuts at the last `-` at or before
 * `maxLen`; falls back to the raw hard cut only when there's no dash to cut
 * on within the budget (one very long unbroken word).
 */
function truncateSlugAtWordBoundary(slug: string, maxLen: number): string {
  if (slug.length <= maxLen) return slug;
  const cut = slug.slice(0, maxLen);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, '');
}

export const CANDIDATE_TITLE_MAX_LEN = 200;

/**
 * Cap a candidate's owner-facing queue title at a WORD boundary with an
 * ellipsis (the raw `sampleTitle` feeding staging is an incident item's own
 * title — arbitrarily long and previously stored verbatim, the scoped-out
 * half of EI-18121665970916886). Applied at the staging funnel so every
 * caller inherits it; dedup is on the signature, never the title.
 */
export function truncateCandidateTitle(title: string, maxLen = CANDIDATE_TITLE_MAX_LEN): string {
  const t = title.trim();
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:—-]+$/g, '')}…`;
}

/** Kebab-case an item id from the title, unique against `taken` (suffix -2, -3, …). */
export function candidateItemId(title: string, taken: ReadonlySet<string>): string {
  const kebab = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = truncateSlugAtWordBoundary(kebab, CANDIDATE_ID_MAX_LEN) || 'fleet-lesson';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
}

/** Bump the patch component of a three-part semver. */
export function bumpPatchVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return '0.0.1';
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Single-line, double-quoted frontmatter value parseFrontmatter round-trips. */
function fmValue(s: string): string {
  return `"${s.replace(/\s+/g, ' ').replace(/"/g, "'").trim()}"`;
}

/**
 * Render the `<item-id>.md` learning file for an adopted candidate. The body
 * is the (possibly owner-edited) draft text plus a provenance footer — packs
 * are curated artifacts; the footer says how strongly this lesson was earned.
 *
 * The footer is deliberately NON-IDENTIFYING (P-006 / D-017). A pack item is a
 * SHIPPED artifact: it reaches fresh installs that share none of our ledger, so
 * internal work-item ids, `harness:<slug>` scope literals and the recurrence
 * signature hash are all dangling references on the other end — noise at best,
 * and residue the release-bundle audit does NOT catch (its identity rule scans
 * for BUILD-BOX identity — unix user, hostname, git identity — not for internal
 * ledger references). Only the recurrence COUNT survives, because that is the
 * part a stranger can actually use: it says how much evidence stands behind the
 * lesson.
 *
 * Nothing is lost. Full traceability lives in the ledger, which is where it
 * belongs: `knowledge_pack_candidates.pack_item_id` links the shipped item back
 * to its candidate row, which retains `source_item_ids`, `signature`, `scopes`
 * and `recurrence_count`. `signature`/`scopes`/`sourceItemIds` stay in this
 * signature (rather than being dropped from the type) because callers pass a
 * whole candidate row through — they are simply not rendered into the artifact.
 */
export function renderCandidateLearningFile(opts: {
  itemId: string;
  title: string;
  text: string;
  kind: LearningKind;
  appliesTo: AppliesTo[];
  signature: string;
  scopes: string[];
  recurrenceCount: number;
  sourceItemIds: string[];
  identityProposal?: boolean;
}): string {
  const appliesTo = opts.appliesTo.length > 0 ? opts.appliesTo : ['any'];
  const provenance = opts.identityProposal ? 'Provenance: explicitly proposed from an identity lesson and adopted after review.' :
    `Provenance: recurred ${opts.recurrenceCount}× across the fleet ` +
    '— adopted from the fleet candidate queue.';
  return [
    '---',
    `id: ${opts.itemId}`,
    `title: ${fmValue(opts.title)}`,
    `kind: ${opts.kind}`,
    // OKF v0.2 `type`, a VERBATIM copy of `kind` — additive, never a
    // replacement (`kind` is what the loader maps onto the seeded memory row).
    // This is the doc-side counterpart of the manifest thread below: every pack
    // doc on disk carries `type` after the P-004 backfill, and this is the only
    // code path that MINTS new ones. Omitting it here would silently walk the
    // corpus back below 100% one fleet-lesson adoption at a time — a regression
    // no test of the backfill itself would ever catch.
    `type: ${opts.kind}`,
    `applies_to: [${appliesTo.join(', ')}]`,
    '---',
    opts.text.trim(),
    '',
    provenance,
    '',
  ].join('\n');
}

/**
 * ⚠ This is a full REWRITE of manifest.yaml, not a patch — it runs on every
 * fleet-lesson adoption. Any manifest field not emitted here is ERASED from disk
 * the next time a candidate is adopted, so a new field must be added in BOTH
 * `parseManifest` (read) and here (write) or it silently evaporates.
 */
function renderManifest(m: KnowledgePackManifest): string {
  return [
    `id: ${m.id}`,
    `title: ${fmValue(m.title)}`,
    `description: ${fmValue(m.description)}`,
    `version: ${fmValue(m.version)}`,
    ...(m.author ? [`author: ${fmValue(m.author)}`] : []),
    ...(m.okfVersion ? [`${OKF_MANIFEST_KEY}: ${fmValue(m.okfVersion)}`] : []),
    '',
  ].join('\n');
}

/**
 * Thrown when the P-009 admission gate refuses an item.
 *
 * A DISTINCT type, not a bare Error, because the refusal is DETERMINISTIC: the
 * item's text will not change on its own, so a caller that retries on failure
 * (the auto-adopt sweep does exactly that) must be able to tell "this will never
 * pass, dismiss it" from "transient, retry next tick". Conflating the two turns
 * one bad candidate into an infinite retry loop across every sweep.
 */
export class PackAdmissionRefused extends Error {
  readonly hits: readonly PackResidueHit[];
  /** True when the class-3 (this-box literal) identity leg actually ran. */
  readonly identityLiteralsScanned: boolean;
  constructor(hits: readonly PackResidueHit[], identityLiteralsScanned: boolean) {
    super(
      `pack-admission gate refused this item — ${hits.length} finding(s):\n` +
        `${formatPackResidue(hits)}\n` +
        (identityLiteralsScanned
          ? ''
          : '(note: this box resolved no identity literals, so the hostname/git-identity ' +
            'leg did not run — the findings above are from the shape-based legs only)'),
    );
    this.name = 'PackAdmissionRefused';
    this.hits = hits;
    this.identityLiteralsScanned = identityLiteralsScanned;
  }
}

/**
 * Write one adopted candidate into the fleet-lessons pack dir (creating the
 * pack on first adoption) and bump the manifest patch version — so every hive
 * with the pack installed sees `updateAvailable` and adopts the new item
 * through the existing upgrade conflict review.
 *
 * GATED (P-009): refuses with {@link PackAdmissionRefused} before writing
 * anything if the item trips the admission gate — the shape floor, internal
 * ledger/scope/session residue, or tier-3 THIS-BOX identity. This is THE
 * chokepoint: both adoption paths (the owner's explicit decide and the automated
 * sweep) funnel through here, so gating it once cannot be routed around by a
 * future caller — which is why the check lives here rather than only in
 * `decideKnowledgePackCandidate`.
 */
export async function materializeCandidateIntoPack(
  opts: {
    title: string;
    text: string;
    kind: LearningKind;
    appliesTo: AppliesTo[];
    signature: string;
    scopes: string[];
    recurrenceCount: number;
    sourceItemIds: string[];
    identityProposal?: boolean;
  },
  io: { packsRoot?: string; identityEntries?: IdentityEntries; target?: { dir: string; packId: string; sourcePath: string } } = {},
): Promise<{ packId: string; packItemId: string; packVersion: string }> {
  // P-009 — gate BEFORE any filesystem write, so a refusal leaves no partial
  // pack and no bumped manifest version behind.
  const verdict = checkPackAdmission(
    { title: opts.title, text: opts.text, kind: opts.kind },
    { identityEntries: io.identityEntries ?? resolvePackIdentityEntries() },
  );
  if (!verdict.ok) {
    throw new PackAdmissionRefused(verdict.hits, verdict.identityLiteralsScanned);
  }

  // P-005 (plan D-005): the SHARED workspace-independent root — candidates are
  // fleet-global, so their pack must not fragment across per-workspace roots.
  const dir = io.target?.dir ?? join(io.packsRoot ?? sharedKnowledgePacksRoot(), FLEET_LESSONS_PACK_ID);
  await fs.mkdir(dir, { recursive: true });

  let manifest: KnowledgePackManifest = FLEET_LESSONS_MANIFEST;
  let originalManifest: Record<string, unknown> | undefined;
  let originalManifestSource: string | undefined;
  try {
    const raw = await fs.readFile(join(dir, 'manifest.yaml'), 'utf8');
    const parsed = parseManifest(raw);
    if (io.target && (!parsed.manifest || parsed.manifest.id !== io.target.packId)) throw new Error('Invalid identity pack manifest.');
    if (parsed.manifest) manifest = parsed.manifest;
    if (io.target) {
      originalManifest = parseYaml(raw) as Record<string, unknown>;
      originalManifestSource = raw;
    }
  } catch (error) {
    if (io.target) throw error;
    /* first adoption — the default manifest above */
  }

  const taken = new Set(
    (await fs.readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, '')),
  );
  const itemId = candidateItemId(opts.title, taken);
  const version = bumpPatchVersion(manifest.version);
  // Read and prepare the authored pin before writing any pack content. A local
  // edit invalidates its prior attestation; publishing signs the new source.
  let nextIdentitySource: string | undefined;
  let originalIdentitySource: string | undefined;
  if (io.target) {
    originalIdentitySource = await fs.readFile(io.target.sourcePath, 'utf8');
    const raw = parseYaml(originalIdentitySource) as Record<string, unknown>;
    if (Array.isArray(raw.bundles)) {
      for (const bundle of raw.bundles) {
        if (bundle.kind === 'knowledge-pack' && bundle.ref === io.target.packId && bundle.version) bundle.version = version;
      }
    }
    delete raw.attestation;
    nextIdentitySource = stringifyYaml(raw);
  }

  // Stamp the OKF version on write when the on-disk manifest predates the field.
  // The fleet-lessons pack lives in the SHARED root (~/.papercusp/...), i.e. OUTSIDE
  // the repo, so the P-004 codemod that edited the three builtin manifests cannot
  // reach it — without this it would stay un-stamped indefinitely.
  const okfVersion = manifest.okfVersion ?? OKF_VERSION;
  const itemPath = join(dir, `${itemId}.md`);
  try {
    await fs.writeFile(itemPath, renderCandidateLearningFile({ ...opts, itemId }), 'utf8');
    await fs.writeFile(
      join(dir, 'manifest.yaml'),
      originalManifest ? stringifyYaml({ ...originalManifest, version, okf_version: okfVersion }) : renderManifest({ ...manifest, version, okfVersion }),
      'utf8',
    );
    if (io.target && nextIdentitySource) {
      await fs.writeFile(io.target.sourcePath, nextIdentitySource, 'utf8');
    }
  } catch (error) {
    // The candidate remains pending on an IO error. Restore authored bytes so
    // retry cannot duplicate a lesson or advance only one of the version pins.
    if (io.target && originalManifestSource && originalIdentitySource) {
      const restored = await Promise.allSettled([
        fs.writeFile(join(dir, 'manifest.yaml'), originalManifestSource, 'utf8'),
        fs.writeFile(io.target.sourcePath, originalIdentitySource, 'utf8'),
        fs.rm(itemPath, { force: true }),
      ]);
      const failures = restored.filter((result) => result.status === 'rejected');
      if (failures.length) throw new AggregateError([error, ...failures.map((result) => result.reason)], 'Identity adoption failed and authored-file rollback was incomplete.');
    }
    throw error;
  }
  return { packId: io.target?.packId ?? FLEET_LESSONS_PACK_ID, packItemId: itemId, packVersion: version };
}

/* ────────────────────────────────────────────────────────────────────────
 * Decide (the owner's adopt / dismiss)
 * ──────────────────────────────────────────────────────────────────────── */

export interface DecideCandidateInput {
  id: string;
  action: 'adopt' | 'dismiss';
  by: string;
  note?: string;
  /** Owner edits applied at adoption (the draft is a starting point). */
  title?: string;
  text?: string;
  kind?: LearningKind;
  appliesTo?: AppliesTo[];
  /** The adopting workspace — used ONLY for the transfer bar (its lessons are
   *  workspace-scoped); the candidate itself is global (P-002). Defaults to the
   *  active workspace. */
  workspaceId?: string;
  /** Test override of the installed packs root. */
  packsRoot?: string;
  /** Internal transaction recursion, never exposed as a tool argument. */
  candidateSql?: ReturnType<typeof getOrgPg>['sql'];
  /** Test override of the transfer bar (lib/transfer/pack-bar). */
  transferBar?: (q: {
    workspaceId: string;
    candidateId: string;
    signature: string;
  }) => Promise<{ blocked: boolean; detail?: string }>;
}

export type DecideCandidateResult =
  | { ok: true; action: 'dismiss'; id: string }
  | { ok: true; action: 'adopt'; id: string; packId: string; packItemId: string; packVersion: string }
  | {
      ok: false;
      /**
       * `admission_gate` (P-009) is DETERMINISTIC — the item's text trips the
       * gate and retrying cannot help, so a sweeping caller must dismiss rather
       * than leave it pending. Every other reason here is potentially transient.
       */
      reason: 'not_found' | 'not_pending' | 'pack_write_failed' | 'transfer_bar' | 'admission_gate' | 'immutable_identity_pack' | 'identity_unavailable' | 'identity_pack_required' | 'explicit_review_required';
      error?: string;
    };

/**
 * The owner's decision on one pending candidate. Adoption writes the pack
 * item FIRST, then flips the row — a failed pack write leaves the candidate
 * pending (retryable), never a half-adopted ghost.
 *
 * Adoption also consults the TRANSFER BAR (self-learning-frontier P-022 /
 * D-006: "knowledge-pack candidates inherit the passing-transfer-test bar"):
 * with the papercusp-transfer-harness flag armed, a candidate whose matched
 * transfer lesson FAILED its student-transfer test (or was retired) refuses
 * with reason 'transfer_bar' — the candidate stays pending, so the owner can
 * re-decide after a fix or dismiss. Flag OFF ⇒ byte-identical
 * behavior; the bar itself fails open on IO trouble.
 */
export async function decideKnowledgePackCandidate(
  input: DecideCandidateInput,
): Promise<DecideCandidateResult> {
  const sql = input.candidateSql ?? getOrgPg().sql;
  const ws = input.workspaceId ?? activeWorkspaceId();

  const rows = await sql<CandidateRow[]>`
    SELECT * FROM harness_shared.knowledge_pack_candidates
    WHERE id = ${input.id} AND (workspace_id IS NULL OR workspace_id = ${ws})
    ${input.candidateSql ? sql`FOR UPDATE` : sql``}`;
  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
  const candidate = rowToCandidate(row);

  if (candidate.workspaceId) {
    if (input.by === AUTO_ADOPT_REVIEWER) return { ok: false, reason: 'explicit_review_required' };
    if (!input.candidateSql) {
      return sql.begin(async (tx) => {
        // The locally authored target is shared by proposing workspaces. Lock
        // the pack itself, rather than a workspace-specific candidate queue.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${JSON.stringify(['identity-pack', candidate.targetIdentityId, candidate.targetPackId])}))`;
        return decideKnowledgePackCandidate({ ...input, candidateSql: tx as unknown as typeof sql });
      });
    }
  }

  if (input.action === 'dismiss') {
    await sql`
      UPDATE harness_shared.knowledge_pack_candidates
      SET status = 'dismissed', decided_at = now(), decided_by = ${input.by},
          decision_note = ${input.note ?? null}
      WHERE id = ${input.id} AND status = 'pending'`;
    invalidate(['knowledgePacks.candidates']);
    return { ok: true, action: 'dismiss', id: input.id };
  }

  // D-006 transfer bar — proven-failed lessons don't enter the fleet pack.
  // Lazy import keeps the candidates module loadable in flags/PG-free tests
  // that never adopt; the bar itself is flag-gated + fail-open.
  const bar =
    input.transferBar ??
    (async (q: { workspaceId: string; candidateId: string; signature: string }) =>
      (await import('../transfer/pack-bar')).packCandidateTransferBar(q));
  const barVerdict = await bar({ workspaceId: ws, candidateId: input.id, signature: candidate.signature });
  if (barVerdict.blocked) {
    return { ok: false, reason: 'transfer_bar', ...(barVerdict.detail ? { error: barVerdict.detail } : {}) };
  }

  let written: { packId: string; packItemId: string; packVersion: string };
  try {
    let target: { dir: string; packId: string; sourcePath: string } | undefined;
    if (candidate.targetIdentityId && candidate.targetPackId) {
      const { resolveWritableIdentityPack } = await import('./identity-learning');
      target = { ...await resolveWritableIdentityPack(candidate.targetIdentityId, candidate.targetPackId), packId: candidate.targetPackId };
    }
    written = await materializeCandidateIntoPack(
      {
        title: input.title?.trim() || candidate.title,
        text: input.text?.trim() || candidate.draftText,
        kind: input.kind ?? candidate.kind,
        appliesTo: input.appliesTo ?? candidate.appliesTo,
        signature: candidate.signature,
        scopes: candidate.scopes,
        recurrenceCount: candidate.recurrenceCount,
        sourceItemIds: candidate.sourceItemIds,
        ...(target ? { identityProposal: true } : {}),
      },
      { ...(input.packsRoot ? { packsRoot: input.packsRoot } : {}), ...(target ? { target } : {}) },
    );
  } catch (e) {
    const { IdentityLearningRefused } = await import('./identity-learning');
    if (e instanceof IdentityLearningRefused) return { ok: false, reason: e.reason as 'immutable_identity_pack', error: e.message };
    // P-009: separate the deterministic refusal from a transient write failure —
    // the caller's retry policy depends on which one this is.
    if (e instanceof PackAdmissionRefused) {
      return { ok: false, reason: 'admission_gate', error: e.message };
    }
    return {
      ok: false,
      reason: 'pack_write_failed',
      error: e instanceof Error ? e.message : String(e),
    };
  }

  await sql`
    UPDATE harness_shared.knowledge_pack_candidates
    SET status = 'adopted', decided_at = now(), decided_by = ${input.by},
        decision_note = ${input.note ?? null},
        pack_id = ${written.packId}, pack_item_id = ${written.packItemId}
    WHERE id = ${input.id} AND status = 'pending'`;

  // The version bump makes `updateAvailable` light up on every hive carrying
  // the pack (learning.hive computes it from the catalog) — the existing
  // upgrade review is the adoption path into pools.
  invalidate(['knowledgePacks.candidates', 'knowledgePacks.list', 'learning.hive']);
  return { ok: true, action: 'adopt', id: input.id, ...written };
}

/* ────────────────────────────────────────────────────────────────────────
 * Automated review + auto-adopt (WI-5414 — owner reversal of the owner-gate
 * contract: "the fleet lesson candidates should be auto adopted ... if we
 * still want a 'review' step, that should be an AUTOMATED review step, we
 * already have many mechanisms for this we use for other types of learnings")
 * ──────────────────────────────────────────────────────────────────────── */

/** Default cap on candidates auto-reviewed per sweep tick. */
export const AUTO_ADOPT_MAX_PER_RUN = 10;

export interface AutoReviewVerdict {
  verdict: 'pass' | 'fail' | 'error';
  reason: string;
  /** The rewritten transferable lesson (verdict 'pass' only) — what adoption
   *  materializes into the pack (plan D-003: the pack carries the DISTILLED
   *  text; the candidate row keeps the raw draft as provenance). */
  distilled?: DistilledCandidate;
}

function lazyConflictJudge(): LlmJudge {
  // Lazy — mirrors manage.ts's realJudge(): pulling the judge clients at
  // module load would tax every importer of this module.
  return async (input) => {
    const [{ resolveConflictJudge }, { warnKnowledgePackJudgeUnavailableOnce }] = await Promise.all([
      import('../memory/conflict-judge'),
      import('../memory/anthropic-judge'),
    ]);
    // P-009 (D-016): Jev when a key is stored, else Anthropic. EI-18746586784230719:
    // unconditional, no feature flag — warn so a missing judge silently passing
    // every candidate isn't invisible.
    const resolved = await resolveConflictJudge();
    if (!resolved.available) {
      warnKnowledgePackJudgeUnavailableOnce();
      return { conflicts: [] };
    }
    return resolved.judge(input);
  };
}

function lazyDistillerLlm(): LessonDistillerLlm {
  // Lazy — live-deps pulls the replay/eval subtree; only load it when a
  // review actually runs.
  return async (input) => {
    const { anthropicDistillerLlm } = await import('../transfer/live-deps');
    return anthropicDistillerLlm()(input);
  };
}

/**
 * The automated review — TWO stages (knowledge-pack-loop-integrity P-001):
 *
 *   1. TRANSFERABILITY (./candidate-review): an LLM judge rejects raw
 *      incident bodies / ephemeral state / instance-bound text, and REWRITES
 *      a passing draft into the compact transferable lesson. verdict 'error'
 *      (LLM down, unparseable, no API key) leaves the candidate PENDING —
 *      never adopt-by-default (plan D-004).
 *   2. CONFLICT: the SAME conflict-check machinery the install/upgrade review
 *      + sweepHiveConflicts already run (manage.ts) — the DISTILLED lesson is
 *      judged against the fleet-lessons pack's OWN current items. A reported
 *      contradiction fails the review; an empty pack, no neighbors, or a
 *      degraded judge call pass this stage — checkConflicts fails OPEN (the
 *      transferability stage above is the load-bearing bar).
 */
export async function reviewCandidateForAutoAdopt(
  candidate: Pick<KnowledgePackCandidate, 'title' | 'draftText'> &
    Partial<Pick<KnowledgePackCandidate, 'scopes' | 'recurrenceCount'>>,
  opts: { packsRoot?: string; judge?: LlmJudge; distiller?: LessonDistillerLlm } = {},
): Promise<AutoReviewVerdict> {
  const distiller = opts.distiller ?? lazyDistillerLlm();
  const transferability = await judgeCandidateTransferability(candidate, distiller);
  if (transferability.verdict === 'fail') {
    return { verdict: 'fail', reason: `not a transferable lesson: ${transferability.reason}` };
  }
  if (transferability.verdict === 'error') {
    return { verdict: 'error', reason: transferability.reason };
  }
  const { distilled } = transferability;

  const { loadKnowledgePack } = await import('./load-packs');
  const { checkConflicts } = await import('../memory/conflict-check');
  const loaded = await loadKnowledgePack(
    FLEET_LESSONS_PACK_ID,
    opts.packsRoot ? { roots: [{ dir: opts.packsRoot, source: 'installed' }] } : undefined,
  ).catch(() => null);
  const existing = loaded?.pack.items ?? [];
  if (existing.length === 0) {
    return {
      verdict: 'pass',
      reason: 'transferable; fleet-lessons pack is empty — nothing to conflict with (knowledge-pack sweep scoring)',
      distilled,
    };
  }

  const neighbors = existing.map((i) => ({ id: i.id, text: memoryTextOf(i) }));
  const judge = opts.judge ?? lazyConflictJudge();
  const report = await checkConflicts({ newText: distilled.text, neighbors, judge });
  if (report.conflicts.length > 0) {
    const summary = report.conflicts.map((c) => c.summary).join('; ');
    return {
      verdict: 'fail',
      reason: `conflicts with existing fleet-lessons item(s) (knowledge-pack sweep scoring): ${summary}`,
    };
  }
  return {
    verdict: 'pass',
    reason: 'transferable; no conflict with existing fleet-lessons content (knowledge-pack sweep scoring)',
    distilled,
  };
}

export interface AutoAdoptSweepResult {
  reviewed: number;
  adopted: number;
  dismissed: number;
  /** A review that ERRORED (verdict 'error' — no decide call, D-004) or a
   *  decide() that didn't succeed (e.g. the D-006 transfer bar refused an
   *  adopt) — the candidate stays pending and the next tick retries it. */
  failed: number;
  /** knowledge-pack-settings P-003: adoptionPolicy='owner-approval' — the
   *  whole sweep was skipped (no LLM spend); candidates stay pending for
   *  knowledge_packs:decide_candidate. */
  skippedPolicy?: true;
}

/** Injectable seam (unit tests pin this without PG/LLM). */
export interface AutoAdoptDeps {
  list?: typeof listKnowledgePackCandidates;
  decide?: typeof decideKnowledgePackCandidate;
  review?: typeof reviewCandidateForAutoAdopt;
  recordReviewError?: typeof recordCandidateReviewError;
  clearReviewErrors?: typeof clearCandidateReviewErrors;
}

/** A candidate erroring this many CONSECUTIVE sweeps files a work-item alarm.
 *  (P-001 blender-loop-repair-2026-08-16: the judge was dead 28 days and the
 *  only trace was a journald warn line nobody read.) */
export const REVIEW_ERROR_ALARM_THRESHOLD = 3;

/**
 * Bump the candidate's consecutive-review-error streak (migration 835) and,
 * exactly when the streak crosses {@link REVIEW_ERROR_ALARM_THRESHOLD}, file a
 * work-item so the dead judge is a claimable bug rather than a log line.
 * Best-effort by contract: an alarm-path failure must never break the sweep.
 */
export async function recordCandidateReviewError(id: string, reason: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ review_error_count: number }[]>`
      UPDATE harness_shared.knowledge_pack_candidates
      SET review_error_count = review_error_count + 1,
          last_review_error = ${reason.slice(0, 2_000)},
          last_review_error_at = now()
      WHERE id = ${id}
      RETURNING review_error_count`;
    const streak = rows[0]?.review_error_count ?? 0;
    if (streak === REVIEW_ERROR_ALARM_THRESHOLD) {
      const { createWorkItem } = await import('../work-items');
      await createWorkItem({
        kind: 'bug',
        severity: 'major',
        title: `knowledge-pack candidate ${id} errored ${streak} consecutive auto-adopt sweeps — transferability judge is not deciding it`,
        summary: [
          `The automated review (candidates.ts autoAdoptPendingCandidates) returned verdict 'error' for the SAME candidate ${streak} sweeps in a row, so it stays pending indefinitely.`,
          `Last error reason (carries the raw judge response when the failure is parse-null): ${reason.slice(0, 1_500)}`,
          'A persistent error streak means the judge LLM wiring is broken (unkeyed distiller, gateway down, truncation) — retrying will not decide the candidate. Fix the wiring, then the next sweep decides it.',
        ].join('\n\n'),
        createdBy: AUTO_ADOPT_REVIEWER,
      });
    }
  } catch (e) {
    console.warn(
      `[knowledge-packs] review-error streak recording failed for ${id} (best-effort): ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** Reset the streak once the judge produces ANY usable verdict — the alarm is
 *  about a judge that cannot decide, not about what it decides. Best-effort. */
export async function clearCandidateReviewErrors(id: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      UPDATE harness_shared.knowledge_pack_candidates
      SET review_error_count = 0, last_review_error = NULL, last_review_error_at = NULL
      WHERE id = ${id} AND review_error_count > 0`;
  } catch (e) {
    console.warn(
      `[knowledge-packs] review-error streak clear failed for ${id} (best-effort): ${e instanceof Error ? e.message : e}`,
    );
  }
}

/**
 * Sweep every PENDING candidate (however it was staged, and whichever tick it
 * arrived on) through the automated review, then auto-decide via
 * {@link decideKnowledgePackCandidate} with the {@link AUTO_ADOPT_REVIEWER}
 * machine identity — a passing review adopts, a failing one dismisses with the
 * verdict recorded as the decision note. Run on the improvement-triage cadence
 * (see harness/routines/improvement-actions.ts); best-effort per candidate —
 * one failure never stops the sweep, and a candidate whose decide() call
 * itself fails (e.g. the transfer bar) simply stays pending for the next tick.
 */
export async function autoAdoptPendingCandidates(
  opts: {
    maxPerRun?: number;
    packsRoot?: string;
    workspaceId?: string;
    /** Explicit policy override (tests / callers that already resolved knobs);
     *  omitted ⇒ resolved from the stored settings (knowledge-pack-settings P-003). */
    adoptionPolicy?: 'auto' | 'owner-approval';
  } = {},
  deps: AutoAdoptDeps = {},
): Promise<AutoAdoptSweepResult> {
  // P-003: 'owner-approval' disables the AUTOMATED sweep entirely — candidates
  // stay pending for the manual decide_candidate path, and no judge LLM spend
  // happens in manual mode. Fail-open to 'auto' (the shipped WI-5414 behavior)
  // if the settings read breaks.
  const policy =
    opts.adoptionPolicy ??
    (await import('./config')
      .then((m) => m.resolveKnowledgePackKnobs())
      .then((k) => k.adoptionPolicy)
      .catch(() => 'auto' as const));
  if (policy === 'owner-approval') {
    return { reviewed: 0, adopted: 0, dismissed: 0, failed: 0, skippedPolicy: true };
  }
  const list = deps.list ?? listKnowledgePackCandidates;
  const decide = deps.decide ?? decideKnowledgePackCandidate;
  const review = deps.review ?? reviewCandidateForAutoAdopt;
  const maxPerRun = Math.max(0, opts.maxPerRun ?? AUTO_ADOPT_MAX_PER_RUN);
  const result: AutoAdoptSweepResult = { reviewed: 0, adopted: 0, dismissed: 0, failed: 0 };
  if (maxPerRun === 0) return result;

  const pending = (await list({ status: 'pending', limit: maxPerRun, fleetOnly: true }))
    .filter((candidate) => !candidate.targetIdentityId).slice(0, maxPerRun);
  for (const candidate of pending) {
    result.reviewed += 1;
    let verdict: AutoReviewVerdict;
    try {
      verdict = await review(candidate, opts.packsRoot ? { packsRoot: opts.packsRoot } : {});
    } catch (e) {
      // D-004 (reverses the pre-P-001 fail-open-to-adopt that shipped six raw
      // incident bodies): an errored review NEVER decides — the candidate
      // stays pending and the next tick retries it.
      verdict = {
        verdict: 'error',
        reason: `automated review errored: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (verdict.verdict === 'error') {
      console.warn(`[knowledge-packs] auto-adopt review errored for ${candidate.id} (stays pending): ${verdict.reason}`);
      result.failed += 1;
      // P-001: persist the streak + reason on the row (and alarm at the
      // threshold) so a dead judge is visible in the DB, not only in journald.
      await (deps.recordReviewError ?? recordCandidateReviewError)(candidate.id, verdict.reason);
      continue;
    }
    // Any usable verdict proves the judge is alive — reset the error streak.
    await (deps.clearReviewErrors ?? clearCandidateReviewErrors)(candidate.id);
    const note = `Automated review (${AUTO_ADOPT_REVIEWER}): ${verdict.reason}`;
    const res = await decide({
      id: candidate.id,
      action: verdict.verdict === 'fail' ? 'dismiss' : 'adopt',
      by: AUTO_ADOPT_REVIEWER,
      note,
      // Adoption materializes the DISTILLED lesson (plan D-003); the raw
      // draft stays on the candidate row as provenance.
      ...(verdict.verdict === 'pass' && verdict.distilled
        ? { title: verdict.distilled.title, text: verdict.distilled.text }
        : {}),
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(verdict.verdict === 'pass' && opts.packsRoot ? { packsRoot: opts.packsRoot } : {}),
    });
    if (!res.ok) {
      // P-009: a gate refusal is DETERMINISTIC — the candidate's own text trips
      // it, so "stays pending, next tick retries" would re-judge (and re-spend an
      // LLM call on) the same doomed item on every sweep, forever. Dismiss it
      // with the gate's findings as the decision note so the reason is on the row
      // rather than only in a log line. Every other !ok reason keeps the existing
      // stays-pending behaviour, which is correct for a transient failure.
      if (res.reason === 'admission_gate') {
        const dismissal = await decide({
          id: candidate.id,
          action: 'dismiss',
          by: AUTO_ADOPT_REVIEWER,
          note: `${note}\n\nRefused by the pack-admission gate (P-009): ${res.error ?? 'no detail'}`,
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        });
        if (dismissal.ok) {
          result.dismissed += 1;
        } else {
          result.failed += 1;
        }
        console.warn(
          `[knowledge-packs] auto-adopt: pack-admission gate refused ${candidate.id} — dismissed (retrying cannot help): ${res.error ?? ''}`,
        );
        continue;
      }
      result.failed += 1;
    } else if (res.action === 'adopt') {
      result.adopted += 1;
    } else {
      result.dismissed += 1;
    }
  }
  return result;
}
