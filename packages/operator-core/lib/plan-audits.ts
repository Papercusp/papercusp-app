/**
 * plan-audits — the code-truth audit record and its citation resolver
 * (plan-completion-audit-and-acceptance-verdict-2026-08-13 P-002).
 *
 * WHY THIS EXISTS -------------------------------------------------------------
 * `evaluatePlanAcceptanceGate` verifies the ceremony around a plan's completion:
 * that an acceptance rubric exists, that some grading rates every criterion, and
 * that the grader is not the rubric's author. It never reads what the ratings SAY,
 * never checks the plan's items, and never reads the code. An agent filed the
 * diagnosis on 2026-08-12 (EI-20219912008114544): "a gate that checks completeness
 * is not checking correctness."
 *
 * The audit is the missing half — the implementer traces every plan item to the code
 * that implements it and CITES it, before authoring the acceptance rubric (plan D-004).
 *
 * WHY THE CITATIONS MUST RESOLVE ----------------------------------------------
 * The audit is a SELF-audit (D-004): the implementer checks their own work. That
 * removes the independence leg entirely, so the guard cannot rest on conscientiousness
 * — it rests on this module. A citation that does not resolve against the real tree is
 * REFUSED at write time, and re-resolved again by the gate at ship time because the
 * tree moves in between. That is what makes an audit falsifiable rather than an
 * attestation, which is the whole difference between this and a filled-in form.
 *
 * NOT REUSED, DELIBERATELY: `memory/audit-anchors.ts` already classifies file
 * references, and at first glance `classifyFileAnchor` is the same job. It is not.
 * That classifier is deliberately LENIENT — it accepts a path that does not exist if
 * the basename is unique repo-wide, and skips anything "external by nature" (`/…`,
 * `tmp/…`, `~/…`) — because its purpose is auditing years-old memory anchors without
 * crying wolf. Every one of those leniencies is a hole here: accepting a
 * near-miss path is precisely the rubber stamp this gate exists to catch. What IS
 * borrowed is its shape — a pure core with `exists`/`readFile` injected, so the
 * resolver tests without touching a real tree.
 *
 * STATED LIMIT: this raises the cost of a rubber stamp; it does not make one
 * impossible. Fabricated paths die here, and mass-`none` citation dies at grading
 * (plan P-010 puts the none-ratio in front of the independent grader). An auditor
 * who cites real files that do not implement the item defeats both. Do not describe
 * this module as proving an audit was honest — it proves the citations point at
 * files that exist, which is a strictly weaker and still useful claim.
 */
import { getOrgPg, withWorkspace } from '@papercusp/db-org';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pinModuleState } from '@papercusp/module-singleton';
import { NOTE_SUFFIX_RE, parsePlan } from '@papercusp/plan-parser';
import { activeWorkspaceId } from './workspace-registry';
import type { ItemProvenanceDeclaration, StoredItemProvenanceCheck } from './activation-item-provenance';
import {
  PLAN_ADVISORY_LOCK_NAMESPACE,
  planAdvisoryLockKey,
} from './agent-tools/plans/plan-lock-key';
import { splitPlanSections } from './agent-tools/plans/plan-sections';
import {
  loadHarnessRegistry,
  resolveHarnessContentPath,
  type HarnessRegistry,
} from './harness-registry';
import { discoverKnownHiveCheckoutRoots } from './agent-tools/testing/run';
import { gitSidecarEnabled, noteSidecarFallback, runGitViaSpawnerSidecar } from './fleet/git-via-sidecar';
import { selectUnambiguousEvidenceRoot } from './evidence-root-selection';
// The monorepo-root walk-up lives in the docs tool helper only because that is where
// it was first needed; it is imported rather than re-derived so there stays exactly
// ONE implementation of "where is the repo root" rather than two that can disagree.
import { REPO_ROOT } from './agent-tools/docs/_repo-paths';
import {
  ensureActivationAuditRepairFiling,
  reconcileActivationAuditRepairFiling,
  type ActivationAuditRepairFiling,
  type ActivationAuditRepairReconciliation,
} from './agent-tools/plans/activation-audit-repair';
import {
  AcceptanceBarSeedAbort,
  parseBarMappings,
  parseRequirementBars,
  seedAcceptanceBarsInTransaction,
  type AcceptanceBarSeedCode,
  type AcceptanceBarSeedProblem,
  type TransactionalAcceptanceBarSeedSuccess,
} from './acceptance-bar-seed';
import type { PlanClassRubricRef } from './agent-tools/plans/spec-test-adequacy';
import { hashPlanContent } from './agent-tools/plans/content-hash';
import {
  acceptanceBarSourceFingerprint,
  synchronizeAcceptanceBarSubjectRevision,
} from './acceptance-bar-amendment';

// ── the record ────────────────────────────────────────────────────────────────

/** Per-item audit verdict. Per plan D-002 NONE of these refuses a ship on its own —
 *  they RECORD. The ship-blocking question is the item's own status, not this. */
export const AUDIT_VERDICTS = ['implemented', 'not-code', 'partial', 'missing', 'dropped'] as const;
export type AuditVerdict = (typeof AUDIT_VERDICTS)[number];

/** Citation kinds. Per plan D-008, **only `code`/`test` constitute VERIFICATION** — they
 *  resolve against the real tree and are the sole evidence that an item was built. `doc`
 *  and `none` are explicit declarations of NON-verification: they record where a non-source
 *  deliverable lives, or why none exists, and both are counted so the ratio is visible to
 *  the independent grader (P-010) rather than absorbed into a verified-looking total.
 *
 *  `workitem` was REMOVED here (D-008). A work-item is a record of INTENT, so citing one as
 *  proof that code exists is circular — exactly the "documentation or memory" the owner's
 *  founding instruction excludes. It survives only on `AuditFinding.ref`, where pointing at
 *  a filed out-of-scope bug is the correct use. */
export const CITATION_KINDS = ['code', 'test', 'doc', 'none'] as const;
export type CitationKind = (typeof CITATION_KINDS)[number];

/** The kinds that count as verification against the code. Everything not in this set is
 *  unverified BY CONSTRUCTION — keep this as the single definition so a future kind cannot
 *  become evidence merely by being added to CITATION_KINDS. */
export const VERIFYING_CITATION_KINDS: ReadonlySet<CitationKind> = new Set<CitationKind>(['code', 'test']);

export function isVerifyingCitation(c: AuditCitation): boolean {
  return VERIFYING_CITATION_KINDS.has(c.kind);
}

export interface AuditCitation {
  kind: CitationKind;
  /** Repo-relative path — required for `code`/`test`, optional for `doc` (a doc that IS a
   *  tree file is resolved like any other path; a PG-canonical `/internal/docs/...` doc has
   *  no path and carries `ref` + `reason` instead). */
  path?: string;
  /** Optional line number; validated against the file's actual length. */
  line?: number;
  /** Optional symbol that must literally appear in the cited file. */
  symbol?: string;
  /** A doc id — for `doc` citations that name a PG-canonical doc rather than a tree file. */
  ref?: string;
  /** REQUIRED for `none`, and for a `doc` cited by `ref` alone: why this item has no
   *  code-resolvable artifact. Parity is deliberate — before D-008 `none` demanded a reason
   *  while a doc ref demanded only a non-empty string, so the honest escape cost MORE than
   *  the dodge. */
  reason?: string;
  /** Git-compatible blob hash of the cited file's bytes at audit time. Written by
   *  `plans:audit` for every `code`/`test` citation; never accepted on the wire from
   *  the auditor. D-007 compares this with the current blob so a rewritten file is
   *  stale even when its path and symbol still resolve. */
  blobSha?: string;
}

export interface AuditItemEntry {
  itemId: string;
  verdict: AuditVerdict;
  citations: AuditCitation[];
  /** REQUIRED when verdict is `dropped` — the intentional-departure reason (D-002). */
  note?: string;
  /** Per-item provenance (D-006). Optional only for legacy rows written before the
   *  per-item shape landed; every new `plans:audit` write supplies all three fields. */
  auditedSha?: string | null;
  auditedAt?: string;
  itemTextHash?: string;
  /** Immediate audit pass this unchanged entry was mechanically carried from. The
   *  original auditedSha/auditedAt remain untouched, so carrying cannot re-stamp work
   *  the auditor did not inspect. */
  carriedFrom?: number;
}

export interface AuditFinding {
  summary: string;
  severity?: string;
  /** `filed` REQUIRES `ref` — a finding is never both un-fixed and un-recorded. */
  disposition: 'fixed' | 'filed';
  ref?: string;
}

export const PLAN_AUDIT_KINDS = ['completion', 'activation'] as const;
export type PlanAuditKind = (typeof PLAN_AUDIT_KINDS)[number];

export interface ActivationAuditSourceRange {
  sourceKind: string;
  sessionId: string;
  fromTurn: number;
  toTurn: number;
}

export interface ActivationAuditMapping {
  /** Stable within this audit pass (for example M-003). */
  id: string;
  /** Canonical `session_turn:<kind>:<session>:<turn>` references. */
  sourceRefs: string[];
  /** Concise requirement/constraint/decision distilled from those turns. */
  requirement: string;
  /** R-N, P-NNN, D-NNN, or section:<heading> destinations in the plan. */
  planTargets: string[];
  disposition: 'covered' | 'repaired' | 'rejected' | 'open';
}


export interface ActivationAuditPayload {
  sourceRanges: ActivationAuditSourceRange[];
  mappings: ActivationAuditMapping[];
  repairedOmissions: string[];
  rejectedOrSuperseded: string[];
  unresolvedBlockers: string[];
  /** plan-item-provenance-2026-09-29 P-002: the auditor's explicit declarations for
   *  items that no owner turn backs directly (derived / agent-added). Carried forward
   *  across re-audits; a re-declaration for the same item replaces the prior one. */
  itemProvenance?: ItemProvenanceDeclaration[];
  /** Server-written only (P-002/P-003): the reverse-coverage verdict computed at this
   *  audit. `enforced:false` marks a plan whose earlier audits predate item provenance
   *  (recorded with a warning); the lifecycle gate enforces only `enforced:true`. */
  itemProvenanceCheck?: StoredItemProvenanceCheck;
  /** Server-written only. Repeated re-audits must stay pending until the
   * reviewed BAR amendment advances the stale subject pin. */
  barSeedPendingAmendment?: {
    rubricSlug: string;
    previousSubjectPlanRevision: number;
    currentSubjectPlanRevision: number;
    currentPlanContentHash: string;
    reason: 'acceptance_bar_source_changed';
  };
  /** The audit is durable, but the pinned acceptance rubric cannot be seeded yet.
   * The repair path must fix the rubric before BAR seeding or clause projection
   * can resume; activation must never overwrite the stored data.
   *
   * `acceptance_bar_rubric_invalid` — the stored template_data is malformed.
   * `acceptance_bar_legacy_criteria_unmapped` — the rubric predates BAR adoption
   * (no criterion carries a barKey), so a legacy backfill is owed. Recorded rather
   * than thrown per EI-23376469015732685: throwing deadlocked the whole class of
   * post-epoch DRAFT plans carrying a pre-BAR rubric, because `ready` requires a
   * recorded activation audit and the audit refused on exactly this. */
  barSeedPendingRepair?: {
    rubricSlug: string;
    currentSubjectPlanRevision: number;
    currentPlanContentHash: string;
    reason: 'acceptance_bar_rubric_invalid' | 'acceptance_bar_legacy_criteria_unmapped';
    problems: AcceptanceBarSeedProblem[];
  };
}

export interface ActivationAuditCoverageConflict {
  mappingId?: string;
  code:
    | 'mapping_id_reused'
    | 'mapping_source_refs_dropped'
    | 'mapping_targets_dropped'
    | 'coverage_limit_exceeded';
  detail: string;
}

export type MergeActivationAuditCoverageResult =
  | {
      ok: true;
      activation: ActivationAuditPayload;
      carriedMappingIds: string[];
    }
  | {
      ok: false;
      conflicts: ActivationAuditCoverageConflict[];
    };

/**
 * Preserve the complete conversation map across a material re-audit.
 *
 * Activation rows are append-only snapshots and the reader deliberately selects
 * the newest one. That means a caller submitting only the NEW requirement would
 * otherwise replace (not extend) every prior mapping. The result still looks like
 * a valid activation audit while silently forgetting most of the source
 * conversation — the exact opposite of the gate's purpose.
 *
 * Mapping ids are stable across passes. A caller may extend an existing mapping's
 * refs/targets, but may not reuse its id for a different requirement or remove
 * prior coverage. Omitted ids are carried mechanically, just like unchanged
 * completion-audit entries. Intentional supersession stays explicit: keep the
 * mapping, change its disposition/targets additively, and describe the ruling in
 * rejectedOrSuperseded.
 */
export function mergeActivationAuditCoverage(
  previous: ActivationAuditPayload | null | undefined,
  submitted: ActivationAuditPayload,
): MergeActivationAuditCoverageResult {
  if (!previous) {
    return { ok: true, activation: submitted, carriedMappingIds: [] };
  }

  const conflicts: ActivationAuditCoverageConflict[] = [];
  const submittedById = new Map(submitted.mappings.map((mapping) => [mapping.id, mapping]));
  const carriedMappingIds: string[] = [];
  const mappings: ActivationAuditMapping[] = [];

  for (const prior of previous.mappings) {
    const next = submittedById.get(prior.id);
    if (!next) {
      mappings.push(prior);
      carriedMappingIds.push(prior.id);
      continue;
    }
    if (next.requirement !== prior.requirement) {
      conflicts.push({
        mappingId: prior.id,
        code: 'mapping_id_reused',
        detail:
          `${prior.id} already identifies ${JSON.stringify(prior.requirement)}; ` +
          `allocate a new M-NNN id for ${JSON.stringify(next.requirement)} instead of replacing prior coverage`,
      });
    }
    const nextSources = new Set(next.sourceRefs);
    const droppedSources = prior.sourceRefs.filter((ref) => !nextSources.has(ref));
    if (droppedSources.length) {
      conflicts.push({
        mappingId: prior.id,
        code: 'mapping_source_refs_dropped',
        detail: `${prior.id} drops prior source ref(s): ${droppedSources.join(', ')}`,
      });
    }
    const nextTargets = new Set(next.planTargets);
    const droppedTargets = prior.planTargets.filter((target) => !nextTargets.has(target));
    if (droppedTargets.length) {
      conflicts.push({
        mappingId: prior.id,
        code: 'mapping_targets_dropped',
        detail: `${prior.id} drops prior plan target(s): ${droppedTargets.join(', ')}`,
      });
    }
  }

  if (conflicts.length) return { ok: false, conflicts };

  const priorIds = new Set(previous.mappings.map((mapping) => mapping.id));
  mappings.push(...submitted.mappings.filter((mapping) => priorIds.has(mapping.id)));
  mappings.push(...submitted.mappings.filter((mapping) => !priorIds.has(mapping.id)));

  const rangeKey = (range: ActivationAuditSourceRange) =>
    `${range.sourceKind}\u0000${range.sessionId}\u0000${range.fromTurn}\u0000${range.toTurn}`;
  const ranges = new Map<string, ActivationAuditSourceRange>();
  for (const range of [...previous.sourceRanges, ...submitted.sourceRanges]) ranges.set(rangeKey(range), range);

  // sourceRanges.max(50) bounds each incoming tool request, not the plan's
  // lifetime history. Carry-respawn creates distinct canonical session ids;
  // rejecting their accumulated union forces an auditor to omit real evidence.
  // Keep exact-range deduplication and all prior coverage instead. The separate
  // mapping contract still limits the effective requirement map.
  if (mappings.length > 300) {
    conflicts.push({
      code: 'coverage_limit_exceeded',
      detail:
        `effective activation coverage would contain ${mappings.length} mappings; ` +
        'compact equivalent mapping entries without dropping requirements before re-auditing',
    });
    return { ok: false, conflicts };
  }

  const unique = (values: readonly string[]) => [...new Set(values)];
  return {
    ok: true,
    carriedMappingIds,
    activation: {
      sourceRanges: [...ranges.values()],
      mappings,
      repairedOmissions: unique([...previous.repairedOmissions, ...submitted.repairedOmissions]),
      rejectedOrSuperseded: unique([...previous.rejectedOrSuperseded, ...submitted.rejectedOrSuperseded]),
      unresolvedBlockers: unique([...previous.unresolvedBlockers, ...submitted.unresolvedBlockers]),
      ...mergeItemProvenanceDeclarations(previous.itemProvenance, submitted.itemProvenance),
    },
  };
}

/** Carry prior item declarations forward; a submitted declaration for the same item
 *  replaces the prior one (a re-audit may re-classify an item, never silently lose it). */
export function mergeItemProvenanceDeclarations(
  previous: readonly ItemProvenanceDeclaration[] | undefined,
  submitted: readonly ItemProvenanceDeclaration[] | undefined,
): { itemProvenance?: ItemProvenanceDeclaration[] } {
  if (!previous?.length && !submitted?.length) return {};
  const byItem = new Map<string, ItemProvenanceDeclaration>();
  for (const declaration of previous ?? []) byItem.set(declaration.itemId, declaration);
  for (const declaration of submitted ?? []) byItem.set(declaration.itemId, declaration);
  return { itemProvenance: [...byItem.values()] };
}

export interface AuditedPlanRevision {
  id: number;
  seq: number;
  contentHash: string;
}

/**
 * Semantic changes that require the editing agent to repeat the activation
 * audit. This is deliberately guidance, not a server-side classifier: only the
 * editor has the conversation + change context needed to judge materiality.
 */
export const ACTIVATION_REAUDIT_MATERIAL_CHANGES = [
  'requirements',
  'scope',
  'constraints',
  'decisions',
  'dependencies',
  'sequencing',
  'acceptance criteria',
  'open questions',
  'promised follow-ups',
] as const;

export const ACTIVATION_REAUDIT_COSMETIC_CHANGES = [
  'spelling',
  'formatting',
  'cosmetic-only wording',
] as const;

export interface ActivationAuditEditNotice {
  /** Later writes preserve the append-only audit; they never invalidate it. */
  status: 'preserved';
  auditSeq: number;
  auditedPlanRevision: AuditedPlanRevision;
  currentPlanRevision: {
    /** Null only when best-effort plan-revision capture missed this write. */
    id: number | null;
    /** Null only when best-effort plan-revision capture missed this write. */
    seq: number | null;
    contentHash: string;
    /** The canonical harness_plans CAS version after the edit. */
    planVersion: number;
    recorded: boolean;
  };
  changedSinceAudit: boolean;
  revisionGap: number | null;
  reAudit: {
    decision: 'editing_agent';
    requiredWhen: readonly string[];
    notRequiredWhen: readonly string[];
    instruction: string;
  };
}

export interface PlanAudit {
  planSlug: string;
  harnessSlug: string;
  auditSeq: number;
  createdBy: string;
  createdAt: string;
  auditKind: PlanAuditKind;
  auditedSha: string | null;
  activation: ActivationAuditPayload | null;
  auditedPlanRevision: AuditedPlanRevision | null;
  items: AuditItemEntry[];
  findings: AuditFinding[];
  summary: string | null;
}

// ── citation resolution (pure core) ───────────────────────────────────────────

export type CitationResolution =
  | { ok: true }
  | { ok: false; reason: CitationFailureReason; detail?: string };

export type CitationFailureReason =
  | 'path_missing'
  | 'path_absolute'
  | 'path_escapes_repo'
  | 'file_not_found'
  | 'not_a_file'
  | 'file_untracked'
  | 'line_out_of_range'
  | 'symbol_not_found'
  | 'reason_missing'
  | 'ref_missing';

export interface CitationDeps {
  /** Repo-relative → does a regular file exist there? */
  statFile: (rel: string) => { isFile: boolean } | null;
  /** Repo-relative → file contents, or null when unreadable. */
  readFile: (rel: string) => string | null;
  /**
   * Repo-relative → whether Git tracks the file.
   *
   * `true` means Git confirmed the path is tracked, `false` means Git
   * definitely confirmed it is not tracked, and `null` means tracking could
   * not be determined (for example, the enclosing repository is unavailable
   * or the bounded probe timed out). Only the definite negative is a
   * citation failure.
   */
  isTracked?: (rel: string) => boolean | null;
  /**
   * Repo-relative → the absolute root(s) a miss was actually searched under.
   *
   * A `file_not_found` that names only the path the caller wrote is ambiguous in the
   * one way that costs real time: it cannot distinguish "you wrote the wrong path
   * shape" from "you are resolving against a root you did not expect". Those two have
   * OPPOSITE fixes, and this tool has two roots (the monorepo + admitted siblings, or
   * an explicitly-scoped harness's own tree), so the reader cannot infer which applied.
   * Optional so injected/pure test deps stay a two-field object.
   */
  describeRoots?: (rel: string) => string | null;
  /**
   * EI-22129491468808913: repo-relative `rel` that just MISSED everywhere else →
   * the workspace-relative citation that WOULD resolve, if prefixing `rel` with
   * an admitted sibling repo's name lands on a real file. Null when no such
   * sibling match exists (the common case — most misses are just wrong paths).
   *
   * Why this needs its own probe rather than reusing `within()`'s existing
   * sibling branch: that branch only fires when `rel`'s FIRST SEGMENT already
   * names an admitted sibling (`sidestage/apps/...`). A citation written
   * repo-relative for genuinely cross-repo work (`packages/contracts/...`, no
   * sibling-name prefix at all) never reaches it, so the miss looks identical
   * to a wholly nonexistent path — which is exactly what read to an auditor as
   * "cross-repo citation is unsafe here" rather than "you wrote the wrong path
   * shape". Optional so injected/pure test deps stay a two-field object.
   */
  siblingSuggestion?: (rel: string) => string | null;
  /** Repo-relative → Git-compatible blob hash of the file's current bytes. Optional
   *  only so small injected resolver tests remain a two-function fixture. */
  blobSha?: (rel: string) => string | null;
  /** Repo-relative → Git-compatible blob hash of the file at an audited commit/ref.
   *  Optional only so small injected resolver tests can remain filesystem-pure. */
  blobShaAt?: (rel: string, auditedSha: string) => string | null;
}

/** Git's SHA-1 object id for a blob, without writing it into the object database. */
export function gitBlobSha(body: string | Buffer): string {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

/** Fingerprint only citations that constitute code verification. */
export function citationBlobSha(citation: AuditCitation, deps: CitationDeps): string | null {
  if (!isVerifyingCitation(citation)) return null;
  const rel = citation.path?.trim();
  if (!rel) return null;
  const direct = deps.blobSha?.(rel);
  if (direct) return direct;
  const body = deps.readFile(rel);
  return body == null ? null : gitBlobSha(body);
}

/** Fingerprint a verifying citation at the exact commit/ref recorded by an audit. */
export function citationBlobShaAt(
  citation: AuditCitation,
  auditedSha: string,
  deps: CitationDeps,
): string | null {
  if (!isVerifyingCitation(citation)) return null;
  const rel = citation.path?.trim();
  if (!rel) return null;
  return deps.blobShaAt?.(rel, auditedSha) ?? null;
}

/**
 * `file_not_found` detail: the path the caller wrote, where we actually looked, and —
 * EI-22129491468808913 — a repair suggestion when the same relative path exists under
 * an admitted sibling repo once its name is prefixed.
 */
function missDetail(rel: string, deps: CitationDeps): string {
  const roots = deps.describeRoots?.(rel);
  const base = roots ? `${rel} (searched ${roots})` : rel;
  const suggestion = deps.siblingSuggestion?.(rel);
  return suggestion ? `${base}; did you mean "${suggestion}"?` : base;
}

/**
 * Resolve ONE citation. Pure: fs access is injected.
 *
 * Strictness is the point (see the module header). A `code`/`test` citation passes
 * only when the exact repo-relative path names a real file, any `line` is inside that
 * file, and any `symbol` literally appears in it. There is no basename fallback and
 * no "external path" skip — a citation that needs either of those is not evidence.
 */
export function resolveCitation(citation: AuditCitation, deps: CitationDeps): CitationResolution {
  if (citation.kind === 'none') {
    return citation.reason && citation.reason.trim().length > 0
      ? { ok: true }
      : { ok: false, reason: 'reason_missing' };
  }

  // `doc` (D-008). A doc that IS a tree file resolves exactly like any other path — there
  // was never a reason to exempt it, and the pre-D-008 behaviour (accept any non-empty
  // string) made a doc ref a one-character bypass of the whole audit. A PG-canonical doc
  // (`/internal/docs/...`) has no tree path, so it must carry BOTH a ref and a reason — the
  // same bar `none` pays. Note this only governs whether the citation is well-formed:
  // `doc` never counts as verification either way (see VERIFYING_CITATION_KINDS).
  if (citation.kind === 'doc' && !(citation.path && citation.path.trim().length > 0)) {
    if (!citation.ref || citation.ref.trim().length === 0) return { ok: false, reason: 'ref_missing' };
    return citation.reason && citation.reason.trim().length > 0
      ? { ok: true }
      : { ok: false, reason: 'reason_missing' };
  }

  // code | test — and a `doc` that names a tree file. The resolving kinds.
  const rel = citation.path?.trim();
  if (!rel) return { ok: false, reason: 'path_missing' };
  if (rel.startsWith('/') || rel.startsWith('~')) return { ok: false, reason: 'path_absolute' };
  // Reject traversal on the SEGMENTS, not by substring: a substring test both misses
  // `a/../../b` shapes and false-positives on a legitimate `..foo` filename.
  if (rel.split('/').some((seg) => seg === '..')) return { ok: false, reason: 'path_escapes_repo' };

  const stat = deps.statFile(rel);
  if (!stat) return { ok: false, reason: 'file_not_found', detail: missDetail(rel, deps) };
  if (!stat.isFile) return { ok: false, reason: 'not_a_file', detail: rel };

  if (isVerifyingCitation(citation) && deps.isTracked?.(rel) === false) {
    const roots = deps.describeRoots?.(rel);
    const trackingDetail =
      `${rel} is not tracked in git (git-sync may not have swept it yet, or the path may be ignored and never tracked)`;
    return {
      ok: false,
      reason: 'file_untracked',
      detail: roots ? `${trackingDetail}; searched ${roots}` : trackingDetail,
    };
  }

  if (citation.line != null || citation.symbol != null) {
    const body = deps.readFile(rel);
    if (body == null) return { ok: false, reason: 'file_not_found', detail: missDetail(rel, deps) };
    if (citation.line != null) {
      const lines = body.split('\n').length;
      if (citation.line < 1 || citation.line > lines) {
        return { ok: false, reason: 'line_out_of_range', detail: `${rel}:${citation.line} (file has ${lines} lines)` };
      }
    }
    if (citation.symbol != null && !body.includes(citation.symbol)) {
      return { ok: false, reason: 'symbol_not_found', detail: `${citation.symbol} not in ${rel}` };
    }
  }

  return { ok: true };
}

/**
 * Sibling repositories a plan's citations may legitimately reach.
 *
 * This workspace hosts several INDEPENDENT repos beside the monorepo (sidestage,
 * greenfield-*), and a plan filed under one harness routinely delivers its code into
 * one of them. Rooting citation resolution at REPO_ROOT alone made those plans
 * structurally UNAUDITABLE: the repo-relative path did not exist, the
 * workspace-prefixed shape did not exist either, `..` was refused by both traversal
 * guards, and an absolute path is schema-refused — so no expressible citation could
 * resolve and the ship gate could never be satisfied honestly. That is
 * EI-20430092702151575, which blocked sidestage-seller-dockview-2026-08-14 with all
 * 12 items complete and independently graded.
 *
 * ADMISSION RULE: a direct child of the workspace root whose `.git` is a DIRECTORY.
 * That is precisely "an independent repository", and it EXCLUDES the release and
 * checkpoint worktrees — whose `.git` is a pointer FILE — because those are deploy
 * artifacts of THIS repo and must never stand as evidence for it. Measured on this
 * box: `sidestage/.git` is a directory, while `papercup-release/.git` and
 * `papercup-checkpoint/.git` are worktree pointer files.
 *
 * Citations into a sibling are written workspace-relative (`sidestage/apps/web/...`),
 * which is the shape an operator reaches for first. Containment is still enforced
 * per-root, so the strictness the module header describes is unchanged: a citation
 * passes only when it names a real file under an allowed root.
 */
/**
 * Which directory a name returned by {@link independentSiblingRepos} was actually found
 * under — `workspaceRoot` for the conventional case, `homeRoot` for EI-22188958812917965's
 * (a checkout sitting directly under `$HOME`, one tier further out). Callers MUST resolve
 * each name against ITS OWN parent, never a hardcoded `workspaceRoot`: two different tiers
 * can each hold an entry of the same name, and a bare Set could not tell them apart.
 */
export function independentSiblingRepos(
  repoRoot: string,
  opts: { homeRoot?: string } = {},
): ReadonlyMap<string, string> {
  const workspaceRoot = path.dirname(repoRoot);
  const names = new Map<string, string>();
  let realRepo = repoRoot;
  try {
    realRepo = fs.realpathSync(repoRoot);
  } catch {
    /* keep the literal root */
  }

  // EI-22188958812917965: a checkout need not live inside the conventional
  // `~/papercupai-workspace/` tier at all — the reported case (`~/Restart`) sits
  // directly under the user's home directory, one tier further out than
  // `workspaceRoot`. Scan BOTH tiers so a workspace-relative citation and a
  // home-relative one resolve the same way. `workspaceRoot` is scanned FIRST and
  // therefore wins a same-name collision (Map.set on an existing key is a no-op
  // here since each tier is scanned once, but the order still fixes precedence
  // for the first tier to claim a name).
  const scanRoots = [workspaceRoot];
  const homeRoot = opts.homeRoot ?? os.homedir();
  if (homeRoot && homeRoot !== workspaceRoot) scanRoots.push(homeRoot);

  for (const dir of scanRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (names.has(entry.name)) continue; // an earlier (higher-precedence) tier already claimed this name
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      try {
        // `papercup` is a symlink to the monorepo — realpath dedupes it so the repo
        // can never re-enter as its own sibling under a second name.
        if (fs.realpathSync(abs) === realRepo) continue;
        if (!fs.statSync(path.join(abs, '.git')).isDirectory()) continue;
      } catch {
        continue;
      }
      names.set(entry.name, dir);
    }
  }
  return names;
}

/**
 * Registered project checkouts that may contribute citation evidence.
 *
 * `ProjectEntry.path` is the registry's authoritative content path, but not every
 * registered path is a checkout: a repo-less Hive home is a state directory, and
 * release/checkpoint worktrees expose a `.git` pointer FILE. Only paths with a real
 * `.git` DIRECTORY are admitted, matching `independentSiblingRepos`'s worktree
 * exclusion without requiring callers to know the workspace layout.
 */
export function registeredCitationRepoRoots(
  reg: Pick<HarnessRegistry, 'projects'>,
): ReadonlyArray<string> {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const project of reg.projects) {
    const root = path.resolve(project.path);
    try {
      if (!fs.statSync(path.join(root, '.git')).isDirectory()) continue;
      const key = fs.realpathSync(root);
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(root);
    } catch {
      // Missing/stale registry paths and pointer-file worktrees are not evidence roots.
    }
  }
  return roots;
}

interface TrackedRepoSnapshot {
  indexIdentity: string;
  tracked: ReadonlySet<string>;
  /** Index entries with mode 160000 (submodule gitlinks), from the same listing. */
  gitlinks: ReadonlySet<string>;
}

interface RepoCitationTrackingCacheState {
  snapshots: Map<string, TrackedRepoSnapshot>;
  loads: number;
  /**
   * Commit-addressed Git lookups (`<full-sha>:<path>` objects and gitlink pins at a
   * full SHA). Their answers cannot change, so a positive result is memoized forever
   * (bounded) instead of re-forking Git on every acceptance sweep.
   */
  immutable: Map<string, string>;
  /** Child processes spawned SYNCHRONOUSLY by the citation resolver (test observability). */
  syncSpawns: number;
}

// WI-2146577: `repoCitationDeps()` is constructed repeatedly while one acceptance
// sweep selects a root, revalidates it, and evaluates every plan. A cache local to
// one deps object therefore still ran synchronous `git ls-files --error-unmatch`
// once per citation on the bg-host main thread. A CPU profile attributed 1.2s of a
// 5s sample to those probes. Cache the complete tracked set per ACTUAL Git root and
// key it to the index identity: staged/committed changes invalidate immediately,
// while repeated resolver contexts pay no child-process spawn at all.
const __repoCitationTrackingCache = pinModuleState<RepoCitationTrackingCacheState>(
  '@papercusp/operator-core.repoCitationTrackingCache',
  () => ({ snapshots: new Map(), loads: 0, immutable: new Map(), syncSpawns: 0 }),
);
const TRACKED_REPO_SNAPSHOT_MAX_ROOTS = 16;
const TRACKED_REPO_SNAPSHOT_MAX_BUFFER = 32 * 1024 * 1024;
const IMMUTABLE_GIT_LOOKUP_MAX = 4096;
const FULL_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * P-007 (papercusp-log-performance-remediation-2026-09-23): memoize a commit-addressed
 * lookup. Only a FULL object id is immutable (an abbreviation can become ambiguous), and
 * only a positive answer is kept (a missing object can arrive with a later fetch).
 */
function memoImmutableGitLookup(
  key: string,
  ref: string,
  compute: () => string | null,
): string | null {
  if (!FULL_OBJECT_ID_RE.test(ref)) return compute();
  const hit = __repoCitationTrackingCache.immutable.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  if (value !== null) {
    const cache = __repoCitationTrackingCache.immutable;
    cache.set(key, value);
    if (cache.size > IMMUTABLE_GIT_LOOKUP_MAX) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return value;
}

/** Parse `git ls-files -s -z --full-name`: `<mode> <object> <stage>\t<path>\0`. */
function parseStagedListing(stdout: string): { tracked: Set<string>; gitlinks: Set<string> } {
  const tracked = new Set<string>();
  const gitlinks = new Set<string>();
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const file = record.slice(tab + 1);
    if (!file) continue;
    tracked.add(file);
    if (record.startsWith('160000 ')) gitlinks.add(file);
  }
  return { tracked, gitlinks };
}

/** The cached snapshot for `root`, only while it still matches the live index. */
function currentTrackedSnapshot(root: string, gitDir: string): TrackedRepoSnapshot | null {
  const cached = __repoCitationTrackingCache.snapshots.get(root);
  if (!cached) return null;
  return cached.indexIdentity === gitIndexIdentity(gitDir) ? cached : null;
}

function gitDirForRoot(root: string): string | null {
  const marker = path.join(root, '.git');
  try {
    const stat = fs.statSync(marker);
    if (stat.isDirectory()) return marker;
    if (!stat.isFile()) return null;
    const match = /^gitdir:\s*(.+)$/im.exec(fs.readFileSync(marker, 'utf8'));
    return match?.[1] ? path.resolve(root, match[1].trim()) : null;
  } catch {
    return null;
  }
}

function gitRootForFile(abs: string): { root: string; gitDir: string; rel: string } | null {
  let root = path.dirname(abs);
  while (true) {
    const gitDir = gitDirForRoot(root);
    if (gitDir) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      return rel && !rel.startsWith('../') ? { root, gitDir, rel } : null;
    }
    const parent = path.dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

/**
 * Resolve an object at a commit/ref without trusting the moving worktree. The ref is
 * validated by callers before it reaches Git; the path is after `--` so a citation
 * cannot become an option.
 */
function gitObjectShaAt(root: string, ref: string, rel: string): string | null {
  return memoImmutableGitLookup(`object\0${root}\0${ref}\0${rel}`, ref, () =>
    gitObjectShaAtUncached(root, ref, rel),
  );
}

function gitObjectShaAtUncached(root: string, ref: string, rel: string): string | null {
  __repoCitationTrackingCache.syncSpawns += 1;
  try {
    const object = execFileSync(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${ref}:${rel}`],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
        killSignal: 'SIGKILL',
      },
    ).trim();
    return /^[0-9a-f]{40}$/i.test(object) ? object : null;
  } catch {
    return null;
  }
}

/**
 * A submodule's working tree has its own Git root, while the audited SHA belongs to
 * the containing superproject. Resolve the gitlink at that superproject commit and
 * use its pinned child commit for the cited path. Without this bridge, a valid
 * `libs/foo/src/index.ts` citation is looked up as `superprojectSha:src/index.ts`
 * inside the child repository and is reported as `citation_audited_sha_unresolvable`.
 */
function gitlinkCommitAt(
  superprojectRoot: string,
  auditedSha: string,
  gitlinkRel: string,
): string | null {
  return memoImmutableGitLookup(
    `gitlink\0${superprojectRoot}\0${auditedSha}\0${gitlinkRel}`,
    auditedSha,
    () => gitlinkCommitAtUncached(superprojectRoot, auditedSha, gitlinkRel),
  );
}

function gitlinkCommitAtUncached(
  superprojectRoot: string,
  auditedSha: string,
  gitlinkRel: string,
): string | null {
  __repoCitationTrackingCache.syncSpawns += 1;
  try {
    const output = execFileSync(
      'git',
      ['ls-tree', '--full-tree', auditedSha, '--', gitlinkRel],
      {
        cwd: superprojectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
        killSignal: 'SIGKILL',
      },
    ).trim();
    const line = output.split('\n').find(Boolean);
    const match = /^160000 commit ([0-9a-f]{40})\t/.exec(line ?? '');
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function gitlinkParentForRepo(
  repoRoot: string,
): { superprojectRoot: string; gitlinkRel: string } | null {
  // Starting at the child root's parent deliberately skips the child's own `.git`
  // marker and finds the containing repository, if this checkout is a submodule.
  const parent = gitRootForFile(repoRoot);
  if (!parent || parent.root === repoRoot) return null;
  const gitlinkRel = path.relative(parent.root, repoRoot).split(path.sep).join('/');
  if (!gitlinkRel || gitlinkRel.startsWith('../') || path.isAbsolute(gitlinkRel)) return null;
  // P-007: a warm snapshot of the parent index already carries every gitlink, so the
  // common (prewarmed) path answers without forking Git on the request host.
  const warm = currentTrackedSnapshot(parent.root, parent.gitDir);
  if (warm) return warm.gitlinks.has(gitlinkRel) ? { superprojectRoot: parent.root, gitlinkRel } : null;
  __repoCitationTrackingCache.syncSpawns += 1;
  try {
    const indexEntry = execFileSync(
      'git',
      ['ls-files', '--stage', '--', gitlinkRel],
      {
        cwd: parent.root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
        killSignal: 'SIGKILL',
      },
    ).trim();
    if (!indexEntry.split('\n').some((line) => line.startsWith('160000 '))) return null;
  } catch {
    return null;
  }
  return { superprojectRoot: parent.root, gitlinkRel };
}

function gitCitationBlobShaAt(
  fileRepo: { root: string; rel: string },
  auditedSha: string,
): string | null {
  if (!/^[0-9a-f]{7,64}$/i.test(auditedSha)) return null;
  const gitlinkParent = gitlinkParentForRepo(fileRepo.root);
  if (!gitlinkParent) return gitObjectShaAt(fileRepo.root, auditedSha, fileRepo.rel);

  const childSha = gitlinkCommitAt(
    gitlinkParent.superprojectRoot,
    auditedSha,
    gitlinkParent.gitlinkRel,
  );
  return childSha ? gitObjectShaAt(fileRepo.root, childSha, fileRepo.rel) : null;
}

function gitIndexIdentity(gitDir: string): string | null {
  try {
    const stat = fs.statSync(path.join(gitDir, 'index'), { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  } catch {
    return null;
  }
}

function touchTrackedRepoSnapshot(root: string, snapshot: TrackedRepoSnapshot): void {
  __repoCitationTrackingCache.snapshots.delete(root);
  __repoCitationTrackingCache.snapshots.set(root, snapshot);
  while (__repoCitationTrackingCache.snapshots.size > TRACKED_REPO_SNAPSHOT_MAX_ROOTS) {
    const oldest = __repoCitationTrackingCache.snapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    __repoCitationTrackingCache.snapshots.delete(oldest);
  }
}

function trackedFromRepoSnapshot(abs: string): boolean | null {
  const repo = gitRootForFile(abs);
  if (!repo) return null;
  const before = gitIndexIdentity(repo.gitDir);
  if (!before) return null;

  const cached = __repoCitationTrackingCache.snapshots.get(repo.root);
  if (cached?.indexIdentity === before) {
    touchTrackedRepoSnapshot(repo.root, cached);
    return cached.tracked.has(repo.rel);
  }

  __repoCitationTrackingCache.syncSpawns += 1;
  try {
    const probe = spawnSync('git', ['-C', repo.root, ...TRACKED_LISTING_ARGS], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: TRACKED_REPO_SNAPSHOT_MAX_BUFFER,
    });
    const after = gitIndexIdentity(repo.gitDir);
    // If Git rewrote the index while the snapshot was being read, do not cache or
    // answer from a mixed generation. The existing per-path probe below remains
    // the fail-soft fallback for this rare race.
    if (probe.status !== 0 || typeof probe.stdout !== 'string' || after !== before) return null;
    const snapshot: TrackedRepoSnapshot = { indexIdentity: before, ...parseStagedListing(probe.stdout) };
    __repoCitationTrackingCache.loads += 1;
    touchTrackedRepoSnapshot(repo.root, snapshot);
    return snapshot.tracked.has(repo.rel);
  } catch {
    return null;
  }
}

const TRACKED_LISTING_ARGS = ['ls-files', '-s', '-z', '--full-name'] as const;

/**
 * Run a read-only `git -C <root> <args>` WITHOUT blocking the event loop: through the
 * spawner sidecar when enabled for this host (no fork of the large request process),
 * otherwise an async local child. Null on any failure — callers keep the sync path.
 */
async function readGitOutputAsync(root: string, args: readonly string[]): Promise<string | null> {
  const argv = ['-C', root, ...args];
  if (gitSidecarEnabled('PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR')) {
    try {
      const result = await runGitViaSpawnerSidecar(argv, root, 5_000, process.env);
      if (result.code === 0) return result.stdout;
    } catch (e) {
      noteSidecarFallback('plan-audits', e);
    }
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      argv,
      { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: TRACKED_REPO_SNAPSHOT_MAX_BUFFER },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

async function loadTrackedRepoSnapshotAsync(root: string, gitDir: string): Promise<void> {
  const before = gitIndexIdentity(gitDir);
  if (!before) return;
  if (__repoCitationTrackingCache.snapshots.get(root)?.indexIdentity === before) return;
  const stdout = await readGitOutputAsync(root, TRACKED_LISTING_ARGS);
  // Same mixed-generation rule as the sync loader: an index rewritten mid-read is not cached.
  if (stdout === null || gitIndexIdentity(gitDir) !== before) return;
  __repoCitationTrackingCache.loads += 1;
  touchTrackedRepoSnapshot(root, { indexIdentity: before, ...parseStagedListing(stdout) });
}

/**
 * P-007 / WI-10002829: warm, asynchronously, every index snapshot the SYNCHRONOUS
 * citation resolver is about to consult — the Git root of each cited file under each
 * candidate root, plus that root's containing superproject (the submodule gitlink
 * check). Measured on the :3170 request host (loop-saturation profile, pid 2058561):
 * `trackedFromRepoSnapshot`'s spawnSync was 28% of real main-thread work in the window
 * that stalled the first native plan-popup. Best-effort: a miss leaves the existing
 * sync path to answer exactly as before.
 */
export async function prewarmRepoCitationTracking(
  roots: readonly string[],
  citations: readonly AuditCitation[],
): Promise<void> {
  const gitRoots = new Map<string, string>();
  const note = (repo: { root: string; gitDir: string } | null): void => {
    if (repo && !gitRoots.has(repo.root)) gitRoots.set(repo.root, repo.gitDir);
  };
  for (const root of new Set(roots.map((entry) => path.resolve(entry)))) {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    for (const citation of citations) {
      const rel = isVerifyingCitation(citation) ? citation.path?.trim() : undefined;
      if (!rel) continue;
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(rootWithSep) || !fs.existsSync(abs)) continue;
      const repo = gitRootForFile(abs);
      if (!repo || gitRoots.has(repo.root)) continue;
      note(repo);
      const parent = gitRootForFile(repo.root);
      if (parent && parent.root !== repo.root) note(parent);
    }
  }
  await Promise.all(
    [...gitRoots].map(([root, gitDir]) => loadTrackedRepoSnapshotAsync(root, gitDir).catch(() => undefined)),
  );
}

/** Test-only observability for the spawn-collapse and index-invalidation contract. */
export function __repoCitationTrackingCacheStatsForTests(): { roots: number; loads: number } {
  return {
    roots: __repoCitationTrackingCache.snapshots.size,
    loads: __repoCitationTrackingCache.loads,
  };
}

/** Test-only: synchronous Git child processes the citation resolver has spawned. */
export function __repoCitationSyncSpawnsForTests(): number {
  return __repoCitationTrackingCache.syncSpawns;
}

export function __resetRepoCitationTrackingCacheForTests(): void {
  __repoCitationTrackingCache.snapshots.clear();
  __repoCitationTrackingCache.loads = 0;
  __repoCitationTrackingCache.immutable.clear();
  __repoCitationTrackingCache.syncSpawns = 0;
}

/** Real-filesystem deps rooted at the monorepo, plus admitted sibling/registered repos. */
export function repoCitationDeps(
  repoRoot: string = REPO_ROOT,
  registeredRoots: readonly string[] = [],
): CitationDeps {
  const workspaceRoot = path.dirname(repoRoot);
  let siblings: ReadonlyMap<string, string> | null = null;
  const trackedCache = new Map<string, boolean | null>();
  let realRepo: string | null = null;
  try {
    realRepo = fs.realpathSync(repoRoot);
  } catch {
    /* keep the literal root for containment; registered-root dedupe is best effort */
  }
  const admittedRegisteredRoots = [...new Set(
    registeredRoots
      .map((root) => path.resolve(root))
      .filter((root) => {
        try {
          if (!fs.statSync(path.join(root, '.git')).isDirectory()) return false;
          return realRepo === null || fs.realpathSync(root) !== realRepo;
        } catch {
          return false;
        }
      }),
  )];

  const contained = (root: string, rel: string): string | null => {
    const abs = path.resolve(root, rel);
    // Second traversal guard, on the RESOLVED path: catches symlink-free `..`
    // survivors and any shape the segment check above did not anticipate.
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    return abs === root || abs.startsWith(rootWithSep) ? abs : null;
  };

  const within = (rel: string): string | null => {
    const inRepo = contained(repoRoot, rel);
    // In-repo always wins, so a sibling can never shadow a real monorepo file.
    if (inRepo !== null && fs.existsSync(inRepo)) return inRepo;
    const first = rel.split('/')[0];
    if (first) {
      // Computed lazily: the overwhelmingly common in-repo citation pays no scan.
      siblings ??= independentSiblingRepos(repoRoot);
      const siblingParent = siblings.get(first);
      if (siblingParent !== undefined) {
        const inWorkspace = contained(siblingParent, rel);
        if (inWorkspace !== null) return inWorkspace;
      }
    }
    // Registered project roots are explicit admission, so nested app checkouts do
    // not need to be moved/symlinked to a workspace sibling before they can be
    // cited. The selected root and direct siblings retain precedence above.
    for (const registeredRoot of admittedRegisteredRoots) {
      const inRegisteredRoot = contained(registeredRoot, rel);
      if (inRegisteredRoot !== null && fs.existsSync(inRegisteredRoot)) return inRegisteredRoot;
    }
    // A genuine miss still reports against the repo, so `file_not_found` names the
    // path the caller actually wrote rather than a sibling guess.
    return inRepo;
  };
  return {
    statFile: (rel) => {
      const abs = within(rel);
      if (!abs) return null;
      try {
        return { isFile: fs.statSync(abs).isFile() };
      } catch {
        return null;
      }
    },
    readFile: (rel) => {
      const abs = within(rel);
      if (!abs) return null;
      try {
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    },
    blobSha: (rel) => {
      const abs = within(rel);
      if (!abs) return null;
      try {
        return gitBlobSha(fs.readFileSync(abs));
      } catch {
        return null;
      }
    },
    blobShaAt: (rel, auditedSha) => {
      const abs = within(rel);
      if (!abs) return null;
      const repo = gitRootForFile(abs);
      return repo ? gitCitationBlobShaAt(repo, auditedSha) : null;
    },
    isTracked: (rel) => {
      const abs = within(rel);
      if (!abs) return null;
      const cached = trackedCache.get(abs);
      if (cached !== undefined) return cached;

      let tracked: boolean | null = null;
      const repoDir = path.dirname(abs);
      if (fs.existsSync(abs) && fs.existsSync(repoDir)) {
        tracked = trackedFromRepoSnapshot(abs);
        if (tracked === null) {
          try {
            const probe = spawnSync(
              'git',
              ['-C', repoDir, 'ls-files', '--error-unmatch', '--', abs],
              {
                encoding: 'utf8',
                stdio: ['ignore', 'ignore', 'ignore'],
                timeout: 5_000,
                killSignal: 'SIGKILL',
              },
            );
            tracked = probe.status === 0 ? true : probe.status === 1 ? false : null;
          } catch {
            tracked = null;
          }
        }
      }
      trackedCache.set(abs, tracked);
      return tracked;
    },
    // Report the roots this rel was ACTUALLY tried under, not the whole ambient
    // filesystem. The repo root is always consulted; the workspace root only when
    // the first segment names an admitted sibling; registered roots are explicit
    // citation candidates and are consulted after those two precedence tiers.
    describeRoots: (rel) => {
      const roots = [repoRoot];
      const first = rel.split('/')[0];
      if (first) {
        siblings ??= independentSiblingRepos(repoRoot);
        const siblingParent = siblings.get(first);
        if (siblingParent !== undefined) roots.push(path.join(siblingParent, first));
      }
      roots.push(...admittedRegisteredRoots);
      return roots.join(', ');
    },
    siblingSuggestion: (rel) => {
      siblings ??= independentSiblingRepos(repoRoot);
      const first = rel.split('/')[0];
      for (const [name, parent] of siblings) {
        // Already-prefixed misses were already tried above by `within()` — a
        // second suggestion naming the same prefix would be noise, not a repair.
        if (name === first) continue;
        const abs = path.resolve(parent, name, rel);
        try {
          if (fs.statSync(abs).isFile()) return `${name}/${rel}`;
        } catch {
          /* not there either — keep looking */
        }
      }
      return null;
    },
  };
}

/** Resolve the canonical source root for an explicitly-scoped harness.
 *
 * A harness registry path outranks a same-slug workspace sibling: the latter may be
 * an old clone while the live staging hive is rooted under ~/.papercusp/hives. Keeping
 * this pure seam separate makes that precedence testable without reading PG. */
export function harnessCitationRepoRoot(
  reg: Pick<HarnessRegistry, 'projects'>,
  harnessSlug: string,
): string | null {
  return resolveHarnessContentPath(reg, harnessSlug) ?? null;
}

/** Where a selected citation root came from — derivable at any later read by re-running
 *  the same selection, so it is exposed on results rather than stored as a second copy. */
export type CitationRootSource = 'registry' | 'hive-checkout' | 'canonical-repo';

export interface SelectedCitationRoot {
  root: string;
  source: CitationRootSource;
}

/** A verifying citation that could not resolve in any available citation root. */
export interface CitationFailure {
  path?: string;
  line?: number;
  symbol?: string;
  reason: CitationFailureReason;
  detail?: string;
}

/** A citation failure is distinct from an unavailable or ambiguous harness root. */
export interface CitationContextFailure {
  kind: 'citation_unresolvable';
  citations: CitationFailure[];
}

export type RepoCitationContext =
  | { repoRoot: string; deps: CitationDeps; rootSource: CitationRootSource }
  | CitationContextFailure;

export function isCitationContextFailure(
  value: RepoCitationContext | null,
): value is CitationContextFailure {
  return value !== null && 'kind' in value && value.kind === 'citation_unresolvable';
}

/**
 * Select a citation root for a repo-less Hive when its registry-selected member path is stale.
 *
 * The registry path remains authoritative when every verifying citation resolves there. Only a
 * repo-less Hive may fall back to discovered Hive checkouts, and only when exactly one candidate
 * resolves every verifying citation. Pointer-file worktrees (checkpoint/release artifacts) are
 * excluded; a tie is refused rather than turning a citation into evidence from an arbitrary tree.
 *
 * WI-41365: a hive plan whose implementation landed in the CANONICAL repo (papercusp-core
 * changes commissioned by a hive) was previously unauditable from every session — the registry
 * root was stale and no discovered hive checkout carried the evidence, so the resolver failed
 * closed on exactly the plans whose fixes live here. The canonical repo is now the LAST rung:
 * accepted only when NO discovered hive checkout resolves the citations (zero ambiguity) and
 * the canonical tree resolves them ALL, and labeled `source: 'canonical-repo'` so a reader can
 * tell hive-tree evidence from canonical-repo evidence. Ambiguity still refuses.
 */
export function selectHarnessCitationRepoRoot(
  reg: Pick<HarnessRegistry, 'projects'>,
  harnessSlug: string,
  citations: readonly AuditCitation[],
  discoveredRoots: readonly string[] = [],
  canonicalRepoRoot: string = REPO_ROOT,
  registeredRoots: readonly string[] = [],
): SelectedCitationRoot | null {
  const canonical = harnessCitationRepoRoot(reg, harnessSlug);
  if (!canonical) return null;

  const verifying = citations.filter(isVerifyingCitation);
  const resolvesEveryCitation = (root: string): boolean => {
    const deps = repoCitationDeps(root, registeredRoots);
    return verifying.every((citation) => resolveCitation(citation, deps).ok);
  };
  const project = reg.projects.find((entry) => entry.slug === harnessSlug);
  const mayFallback = Boolean(project && project.harness_kind === 'hive' && !project.self_repo);
  const candidates: SelectedCitationRoot[] = mayFallback
    ? [...new Set(discoveredRoots.map((root) => path.resolve(root)))]
      .filter((root) => {
        try {
          // A .git pointer identifies a worktree/deploy artifact, not an independent Hive checkout.
          return fs.statSync(path.join(root, '.git')).isDirectory();
        } catch {
          return false;
        }
      })
      .map((root) => ({ root, source: 'hive-checkout' }))
    : [];

  return selectUnambiguousEvidenceRoot<CitationRootSource>({
    preferred: { root: canonical, source: 'registry' },
    candidates,
    ...(mayFallback
      ? { fallback: { root: canonicalRepoRoot, source: 'canonical-repo' as const } }
      : {}),
    resolvesEvery: resolvesEveryCitation,
  });
}

/** Citation context shared by audit-write and ship-time revalidation.
 * An explicit but unregistered harness fails closed instead of silently validating
 * against Papercusp's own checkout. */
export async function repoCitationContextForHarness(
  harnessSlug: string | null | undefined,
  citations: readonly AuditCitation[] = [],
): Promise<RepoCitationContext | null> {
  // P-007: every root below is resolved by SYNCHRONOUS deps; warm their Git index
  // snapshots off the event loop first (roots' parents cover admitted sibling repos).
  const prewarm = (roots: readonly string[]): Promise<void> =>
    prewarmRepoCitationTracking([...roots, ...roots.map((root) => path.dirname(root))], citations)
      .catch(() => undefined);
  if (!harnessSlug || harnessSlug === '*') {
    await prewarm([REPO_ROOT]);
    return { repoRoot: REPO_ROOT, deps: repoCitationDeps(REPO_ROOT), rootSource: 'canonical-repo' };
  }
  try {
    const reg = await loadHarnessRegistry();
    const project = reg.projects.find((entry) => entry.slug === harnessSlug);
    const registeredRoots = registeredCitationRepoRoots(reg);
    const fallbackRoots = project?.harness_kind === 'hive' && !project.self_repo
      ? discoverKnownHiveCheckoutRoots()
      : [];
    const canonicalRoot = harnessCitationRepoRoot(reg, harnessSlug);
    await prewarm([...(canonicalRoot ? [canonicalRoot] : []), ...fallbackRoots, REPO_ROOT]);
    const selected = selectHarnessCitationRepoRoot(
      reg,
      harnessSlug,
      citations,
      fallbackRoots,
      REPO_ROOT,
      registeredRoots,
    );
    return selected
      ? {
          repoRoot: selected.root,
          deps: repoCitationDeps(selected.root, registeredRoots),
          rootSource: selected.source,
        }
      : citationFailureForAvailableRoots(reg, harnessSlug, citations, fallbackRoots, registeredRoots);
  } catch {
    return null;
  }
}

/**
 * When no single root can satisfy the whole citation set, distinguish a citation that is
 * absent everywhere from a root-selection refusal (ambiguous/stale harness roots). The latter
 * remains `null`, because each citation may exist somewhere but no one checkout is authoritative.
 */
function citationFailureForAvailableRoots(
  reg: Pick<HarnessRegistry, 'projects'>,
  harnessSlug: string,
  citations: readonly AuditCitation[],
  discoveredRoots: readonly string[],
  registeredRoots: readonly string[] = [],
): CitationContextFailure | null {
  const canonical = harnessCitationRepoRoot(reg, harnessSlug);
  if (!canonical) return null;

  const project = reg.projects.find((entry) => entry.slug === harnessSlug);
  const mayFallback = Boolean(project && project.harness_kind === 'hive' && !project.self_repo);
  const discovered = mayFallback
    ? [...new Set(discoveredRoots.map((root) => path.resolve(root)))].filter((root) => {
        try {
          return fs.statSync(path.join(root, '.git')).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
  const roots = [...new Set([canonical, ...discovered, ...(mayFallback ? [REPO_ROOT] : [])])];
  const verifying = citations.filter(isVerifyingCitation);
  if (verifying.length === 0) return null;

  const failures = verifying.flatMap((citation): CitationFailure[] => {
    const results = roots.map((root) => resolveCitation(citation, repoCitationDeps(root, registeredRoots)));
    if (results.some((result) => result.ok)) return [];
    const firstFailure = results.find(
      (result): result is Extract<CitationResolution, { ok: false }> => !result.ok,
    );
    if (!firstFailure) return [];
    return [{
      ...(citation.path !== undefined ? { path: citation.path } : {}),
      ...(citation.line !== undefined ? { line: citation.line } : {}),
      ...(citation.symbol !== undefined ? { symbol: citation.symbol } : {}),
      reason: firstFailure.reason,
      ...(firstFailure.detail ? { detail: firstFailure.detail } : {}),
    }];
  });

  return failures.length > 0 ? { kind: 'citation_unresolvable', citations: failures } : null;
}

// ── coverage ──────────────────────────────────────────────────────────────────

export interface AuditCoverage {
  /** Items the audit covers. */
  auditedItems: number;
  /** THE headline number (D-008): items carrying at least one RESOLVING `code`/`test`
   *  citation — i.e. actually verified against the tree. This is the figure P-010's
   *  independent grader spot-checks, and the one no volume of doc refs can inflate.
   *  Before D-008 the reported figure was `citedItems`, which counted a `doc` ref whose
   *  only check was that it was a non-empty string. */
  verifiedItems: number;
  /** verifiedItems / auditedItems, 2dp. Null when there is nothing to divide. */
  verifiedRatio: number | null;
  /** Item ids carrying NO verifying citation — named, not just counted, so the grader can
   *  go straight to them instead of re-deriving the set. */
  unverifiedItemIds: string[];
  /** Of the audited items, how many carry at least one citation of ANY kind. Retained for
   *  continuity, but deliberately NOT the headline: a `doc` citation makes an item cited
   *  without making it verified. */
  citedItems: number;
  /** Of those, how many are cited `none` — the escape hatch (D-004's known soft spot). */
  noneItems: number;
  /** noneItems / auditedItems, rounded to 2dp. Reported so the ratio is a number the
   *  independent grader can read, not a vibe. Null when there is nothing to divide. */
  noneRatio: number | null;
  /** Items whose deliverable is declared non-source. METERED as of D-008: this is the
   *  widest escape hatch in the design — wider than `none` — and before D-008 it was
   *  counted nowhere at all, so an audit marking every item `not-code` reported a clean
   *  sheet. Surfaced beside the unverified counts for exactly that reason. */
  notCodeItems: string[];
  /** Items whose verdict records incomplete work — informational (D-002). */
  unresolvedVerdicts: string[];
  /** Items intentionally departed from, with their reasons (D-002). */
  droppedItems: { itemId: string; reason: string }[];
}

export function summarizeCoverage(items: AuditItemEntry[]): AuditCoverage {
  const audited = items.length;
  let cited = 0;
  let none = 0;
  let verified = 0;
  const unverifiedIds: string[] = [];
  const notCode: string[] = [];
  const unresolved: string[] = [];
  const dropped: { itemId: string; reason: string }[] = [];
  for (const it of items) {
    const kinds = it.citations.map((c) => c.kind);
    // Verification is decided by CITATION KIND, never by the verdict the auditor typed —
    // the verdict is the claim, the resolving code citation is the evidence for it.
    if (it.citations.some(isVerifyingCitation)) verified += 1;
    else unverifiedIds.push(it.itemId);
    if (kinds.some((k) => k !== 'none')) cited += 1;
    if (kinds.length > 0 && kinds.every((k) => k === 'none')) none += 1;
    if (it.verdict === 'not-code') notCode.push(it.itemId);
    if (it.verdict === 'partial' || it.verdict === 'missing') unresolved.push(it.itemId);
    if (it.verdict === 'dropped') dropped.push({ itemId: it.itemId, reason: it.note ?? '' });
  }
  return {
    auditedItems: audited,
    verifiedItems: verified,
    verifiedRatio: audited > 0 ? Math.round((verified / audited) * 100) / 100 : null,
    unverifiedItemIds: unverifiedIds,
    citedItems: cited,
    noneItems: none,
    noneRatio: audited > 0 ? Math.round((none / audited) * 100) / 100 : null,
    notCodeItems: notCode,
    unresolvedVerdicts: unresolved,
    droppedItems: dropped,
  };
}

// ── store ─────────────────────────────────────────────────────────────────────

interface PlanAuditRow {
  plan_slug: string;
  harness_slug: string;
  audit_seq: number;
  created_by: string;
  created_at: string;
  audit_kind?: string;
  audited_sha: string | null;
  activation?: ActivationAuditPayload | null;
  audited_plan_revision_id?: number | string | null;
  audited_plan_revision_seq?: number | null;
  audited_plan_content_hash?: string | null;
  items: AuditItemEntry[] | null;
  findings: AuditFinding[] | null;
  summary: string | null;
}

function rowToAudit(row: PlanAuditRow): PlanAudit {
  return {
    planSlug: row.plan_slug,
    harnessSlug: row.harness_slug,
    auditSeq: row.audit_seq,
    createdBy: row.created_by,
    createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
    auditKind: row.audit_kind === 'activation' ? 'activation' : 'completion',
    auditedSha: row.audited_sha,
    activation: row.activation ?? null,
    auditedPlanRevision:
      row.audited_plan_revision_id != null && row.audited_plan_revision_seq != null && row.audited_plan_content_hash
        ? {
            id: Number(row.audited_plan_revision_id),
            seq: Number(row.audited_plan_revision_seq),
            contentHash: row.audited_plan_content_hash,
          }
        : null,
    items: Array.isArray(row.items) ? row.items : [],
    findings: Array.isArray(row.findings) ? row.findings : [],
    summary: row.summary,
  };
}

/**
 * The gate's read: the most recent audit PASS for a plan. Earlier passes are history
 * and are never rewritten, so "latest" is always the operative one.
 *
 * Fails toward null on an infrastructure error, which the gate reads as "unaudited"
 * — a refusal. That is the safe direction: a database blip must not let an unaudited
 * plan through, and the refusal is recoverable by re-running the audit.
 */
export interface PlanAuditReadScope {
  /** Concrete workspace carrying the plan. Falls back to the ambient request scope. */
  workspaceId?: string;
  /**
   * ⚠ NOT the plan's owning Hive-home slug (`resolvePlanScope`'s collapsed
   * `harnessSlug`) — do not pass `row.harnessSlug` from a `plans:get`-shaped
   * plan row here (EI-21124863090048444). `harness_slug` on `plan_audits` is the
   * CITATION-CONTEXT harness `plans:audit` ran from (so `repoCitationContextForHarness`
   * can re-resolve citations at ship time), which for a Hive with member/sub-harnesses
   * routinely differs from the plan's own Hive home. A strict-equality filter here
   * silently drops a real audit row whenever the two disagree. `recordPlanAudit`'s
   * own audit_seq computation and `getEffectiveItemAudits` both already scope purely
   * by (workspaceId, planSlug) — leave this unset unless you are DELIBERATELY
   * narrowing to one citation-context harness (a rare, explicit need, not the default
   * "read the plan's latest audit" case).
   */
  harnessSlug?: string;
}

export async function getLatestPlanAudit(
  planSlug: string,
  scope: PlanAuditReadScope = {},
): Promise<PlanAudit | null> {
  try {
    const { sql } = getOrgPg();
    const workspaceId = scope.workspaceId ?? activeWorkspaceId();
    const harnessSlug = scope.harnessSlug?.trim() || null;
    const rows = await sql<PlanAuditRow[]>`
      SELECT plan_slug, harness_slug, audit_seq, created_by, created_at, audit_kind, audited_sha,
             activation, audited_plan_revision_id, audited_plan_revision_seq,
             audited_plan_content_hash, items, findings, summary
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${workspaceId}
         AND plan_slug = ${planSlug}
         AND audit_kind = 'completion'
         AND (${harnessSlug}::text IS NULL OR harness_slug = ${harnessSlug})
       ORDER BY audit_seq DESC
       LIMIT 1`;
    const row = rows.find(
      (r) => r.plan_slug === planSlug && (!harnessSlug || r.harness_slug === harnessSlug),
    );
    return row ? rowToAudit(row) : null;
  } catch {
    return null;
  }
}

/** Latest completed pre-activation conversation audit for a plan. */
export async function getLatestActivationAudit(
  planSlug: string,
  scope: PlanAuditReadScope = {},
): Promise<PlanAudit | null> {
  try {
    const { sql } = getOrgPg();
    const workspaceId = scope.workspaceId ?? activeWorkspaceId();
    const harnessSlug = scope.harnessSlug?.trim() || null;
    const rows = await sql<PlanAuditRow[]>`
      SELECT plan_slug, harness_slug, audit_seq, created_by, created_at, audit_kind, audited_sha,
             activation, audited_plan_revision_id, audited_plan_revision_seq,
             audited_plan_content_hash, items, findings, summary
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${workspaceId}
         AND plan_slug = ${planSlug}
         AND audit_kind = 'activation'
         AND (${harnessSlug}::text IS NULL OR harness_slug = ${harnessSlug})
       ORDER BY audit_seq DESC
       LIMIT 1`;
    const row = rows.find(
      (candidate) => candidate.plan_slug === planSlug && (!harnessSlug || candidate.harness_slug === harnessSlug),
    );
    return row ? rowToAudit(row) : null;
  } catch {
    return null;
  }
}

/**
 * Build the response metadata every successful post-audit plan write returns.
 * Exported as a pure core so the materiality contract is pinned without a DB.
 */
export function buildActivationAuditEditNotice(input: {
  audit: PlanAudit;
  currentPlanRevision: { id: number; seq: number; contentHash: string } | null;
  currentContentHash: string;
  planVersion: number;
}): ActivationAuditEditNotice | null {
  const audited = input.audit.auditedPlanRevision;
  if (input.audit.auditKind !== 'activation' || !audited) return null;

  const current = input.currentPlanRevision?.contentHash === input.currentContentHash
    ? input.currentPlanRevision
    : null;
  const changedSinceAudit = current
    ? current.id !== audited.id || current.seq !== audited.seq || current.contentHash !== audited.contentHash
    : input.currentContentHash !== audited.contentHash || input.planVersion > 0;
  const revisionGap = current ? Math.max(0, current.seq - audited.seq) : null;
  const currentLabel = current
    ? `revision ${current.seq}`
    : `plan version ${input.planVersion} (revision row unavailable)`;

  return {
    status: 'preserved',
    auditSeq: input.audit.auditSeq,
    auditedPlanRevision: audited,
    currentPlanRevision: {
      id: current?.id ?? null,
      seq: current?.seq ?? null,
      contentHash: input.currentContentHash,
      planVersion: input.planVersion,
      recorded: current !== null,
    },
    changedSinceAudit,
    revisionGap,
    reAudit: {
      decision: 'editing_agent',
      requiredWhen: ACTIVATION_REAUDIT_MATERIAL_CHANGES,
      notRequiredWhen: ACTIVATION_REAUDIT_COSMETIC_CHANGES,
      instruction:
        `Activation audit #${input.audit.auditSeq} covered revision ${audited.seq}; the plan is now ${currentLabel}. ` +
        `The audit remains recorded. Re-run plans:audit { phase:'activation' } if this edit materially changes ` +
        `${ACTIVATION_REAUDIT_MATERIAL_CHANGES.join(', ')}. ` +
        `${ACTIVATION_REAUDIT_COSMETIC_CHANGES.join(', ')} do not require another audit.`,
    },
  };
}

/**
 * Read the preserved activation audit and compare it with the exact current
 * revision after a plan write. The current row is accepted only when its hash
 * matches the bytes just written; a best-effort revision-capture miss is
 * surfaced truthfully as recorded:false rather than mislabeling an older row.
 */
export async function getActivationAuditEditNotice(input: {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  currentContentHash: string;
  planVersion: number;
}): Promise<ActivationAuditEditNotice | null> {
  const audit = await getLatestActivationAudit(input.planSlug, {
    workspaceId: input.workspaceId,
  });
  if (!audit?.auditedPlanRevision) return null;

  const currentPlanRevision = await withWorkspace(input.workspaceId, async (tx) => {
    const rows = await tx<Array<{ id: number | string; seq: number; content_hash: string }>>`
      SELECT id, seq, content_hash
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${input.harnessSlug}
         AND plan_slug = ${input.planSlug}
       ORDER BY seq DESC
       LIMIT 1`;
    const row = rows[0];
    return row
      ? { id: Number(row.id), seq: Number(row.seq), contentHash: row.content_hash }
      : null;
  });

  return buildActivationAuditEditNotice({
    audit,
    currentPlanRevision,
    currentContentHash: input.currentContentHash,
    planVersion: input.planVersion,
  });
}

export interface EffectiveItemAudit {
  entry: AuditItemEntry;
  /** The pass row in which this effective copy currently lives. A later carry writes
   *  this value into carriedFrom, forming an auditable chain without changing the
   *  entry's original auditedSha/auditedAt. */
  auditSeq: number;
}

/** Pure newest-first fold used by the database read and by the regression guard. */
export function foldEffectiveItemAudits(
  passes: ReadonlyArray<{ auditSeq: number; items: AuditItemEntry[] }>,
): EffectiveItemAudit[] {
  const seen = new Set<string>();
  const effective: EffectiveItemAudit[] = [];
  for (const pass of passes) {
    for (const entry of pass.items) {
      if (!entry?.itemId || seen.has(entry.itemId)) continue;
      seen.add(entry.itemId);
      effective.push({ entry, auditSeq: pass.auditSeq });
    }
  }
  return effective;
}

/**
 * Resolve the latest entry for every item across ALL passes (D-006). Newest pass
 * first, first itemId wins. This deliberately does not assume a pass is a full-plan
 * snapshot: early rows and interrupted/concurrent writers may contain only a subset.
 */
export async function getEffectiveItemAudits(planSlug: string): Promise<EffectiveItemAudit[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<PlanAuditRow[]>`
      SELECT plan_slug, harness_slug, audit_seq, created_by, created_at, audited_sha,
             items, findings, summary
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${activeWorkspaceId()}
         AND plan_slug = ${planSlug}
         AND audit_kind = 'completion'
       ORDER BY audit_seq DESC`;
    return foldEffectiveItemAudits(
      rows.map((row) => ({ auditSeq: row.audit_seq, items: Array.isArray(row.items) ? row.items : [] })),
    );
  } catch {
    return [];
  }
}

/** A plan item as the audit and the gate need it: its id and its status. */
export interface PlanItemStatus {
  itemId: string;
  status: string;
  itemText: string;
}

/**
 * Stable fingerprint of the plan-item requirement text audited.
 *
 * `plans:set-status` may append a mutable ` — note: …` reflection suffix to the
 * indexed item text after an audit. Keep that note in the display/index data,
 * but exclude it from the completion fingerprint so an ownership/status
 * reflection does not masquerade as a requirement edit.
 */
export function planItemTextHash(itemText: string): string {
  return createHash('sha256').update(itemText.replace(NOTE_SUFFIX_RE, '')).digest('hex');
}

/**
 * Hashes accepted when reading an audit entry during the raw→semantic
 * fingerprint migration. New writes use `planItemTextHash`, but older deployed
 * writers hashed the indexed item text verbatim, including any mutable note
 * suffix. Accept both representations on read so audits written by either
 * build can cross the deployment boundary; future writes remain canonical.
 */
export function planItemTextHashCandidates(itemText: string): readonly string[] {
  const semanticHash = planItemTextHash(itemText);
  const rawHash = createHash('sha256').update(itemText).digest('hex');
  return rawHash === semanticHash ? [semanticHash] : [semanticHash, rawHash];
}

/**
 * Build the item array for a new pass. Submitted items receive fresh provenance;
 * unlisted items are copied by the verb with their original provenance intact and
 * an immediate carriedFrom link. Removed items are not resurrected.
 *
 * This is the mechanical anti-rubber-stamp rail from D-006: callers may audit a
 * subset, but they cannot make an uninspected item inherit the pass's new sha/time.
 */
export function prepareAuditPassEntries(input: {
  planItems: PlanItemStatus[];
  submitted: AuditItemEntry[];
  previous: EffectiveItemAudit[];
  auditedSha: string | null;
  auditedAt: string;
}): AuditItemEntry[] {
  const submitted = new Map(input.submitted.map((entry) => [entry.itemId, entry]));
  const previous = new Map(input.previous.map((item) => [item.entry.itemId, item]));
  const merged: AuditItemEntry[] = [];

  for (const planItem of input.planItems) {
    const fresh = submitted.get(planItem.itemId);
    if (fresh) {
      const { carriedFrom: _carriedFrom, auditedSha: _sha, auditedAt: _at, itemTextHash: _text, ...entry } = fresh;
      merged.push({
        ...entry,
        auditedSha: input.auditedSha,
        auditedAt: input.auditedAt,
        itemTextHash: planItemTextHash(planItem.itemText),
      });
      continue;
    }

    const prior = previous.get(planItem.itemId);
    if (prior) merged.push({ ...prior.entry, carriedFrom: prior.auditSeq });
  }

  return merged;
}

/**
 * The plan's items, read from the `plan_items` INDEX rather than by re-parsing the
 * plan body. Two reasons: the index already carries the status (which the gate's
 * unfinished-items check needs), and a full parse is expensive here — plan bodies
 * reach 90KB+ (EI-20200393414409502). The index is rebuilt from the body on every
 * plan write by `plan-index-rows.ts`, so it cannot drift behind the source.
 *
 * Fails toward an EMPTY list. Callers must treat empty as "could not read the items"
 * and never as "the plan has no items" — validating an audit against an empty list
 * would accept every itemId, which is the opposite of this module's job.
 */
export async function getPlanItemStatuses(planSlug: string): Promise<PlanItemStatus[]> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ item_id: string; status: string; item_text: string }[]>`
      SELECT item_id, status, item_text
        FROM harness_shared.plan_items
       WHERE workspace_id = ${activeWorkspaceId()}
         AND plan_slug = ${planSlug}
       ORDER BY seq`;
    return rows.map((r) => ({ itemId: r.item_id, status: r.status, itemText: r.item_text }));
  } catch {
    return [];
  }
}

/** Item statuses that mean "this work is not finished and was not consciously
 *  abandoned". `dropped` is absent on purpose — it is a recorded decision (D-002),
 *  and `done` is the finished case. */
export const UNFINISHED_ITEM_STATUSES = ['todo', 'wip', 'blocked', 'needs-human'] as const;

export interface RecordCompletionAuditInput {
  auditKind?: 'completion';
  planSlug: string;
  harnessSlug: string;
  createdBy: string;
  auditedSha?: string | null;
  items: AuditItemEntry[];
  findings?: AuditFinding[];
  summary?: string | null;
}

export interface RecordActivationAuditInput {
  auditKind: 'activation';
  planSlug: string;
  harnessSlug: string;
  createdBy: string;
  activation: ActivationAuditPayload;
  auditedPlanRevision: AuditedPlanRevision;
  summary?: string | null;
}

export type RecordAuditInput = RecordCompletionAuditInput | RecordActivationAuditInput;

export interface RecordCurrentActivationAuditInput {
  workspaceId: string;
  planSlug: string;
  harnessSlug: string;
  createdBy: string;
  /** The exact class selected by the preceding spec-quality evaluation. */
  classRef: PlanClassRubricRef;
  activation: ActivationAuditPayload;
  summary?: string | null;
}

export interface ActivationAuditPlanTargetProblem {
  mappingId: string;
  target: string;
  code: 'unknown_acceptance_bar' | 'unknown_item' | 'unknown_decision' | 'unknown_section' | 'invalid_plan_target';
  detail: string;
}

/** Validate every mapping destination against the exact plan bytes being audited. */
export function validateActivationAuditPlanTargets(
  activation: ActivationAuditPayload,
  planContent: string,
): ActivationAuditPlanTargetProblem[] {
  const parsed = parsePlan(planContent);
  const items = new Set(parsed.items.map((item) => item.id));
  const decisions = new Set(parsed.decisions.map((decision) => decision.id));
  // Post-epoch plans seed the exact R-N records in ## Requirements as canonical
  // acceptance BARs. Let an activation mapping point at that same record so the
  // conversation requirement remains traceable to the BAR it caused, rather than
  // forcing every such mapping to widen to section:Requirements.
  const requirements = parseRequirementBars(planContent);
  const acceptanceBars = requirements.ok
    ? new Set(requirements.bars.map((bar) => bar.barKey))
    : new Set<string>();
  const sections = new Set(
    splitPlanSections(planContent).map((section) => section.heading.trim().toLowerCase()),
  );
  const problems: ActivationAuditPlanTargetProblem[] = [];
  for (const mapping of activation.mappings) {
    for (const target of mapping.planTargets) {
      if (/^R-\d+$/.test(target)) {
        if (!acceptanceBars.has(target)) {
          problems.push({
            mappingId: mapping.id,
            target,
            code: 'unknown_acceptance_bar',
            detail: `${mapping.id} targets acceptance bar '${target}', which has no exact record in the current Requirements section`,
          });
        }
        continue;
      }
      if (/^P-\d{3,}$/.test(target)) {
        if (!items.has(target)) {
          problems.push({
            mappingId: mapping.id,
            target,
            code: 'unknown_item',
            detail: `${mapping.id} targets item '${target}', which is absent from the current plan revision`,
          });
        }
        continue;
      }
      if (/^D-\d{3,}$/.test(target)) {
        if (!decisions.has(target)) {
          problems.push({
            mappingId: mapping.id,
            target,
            code: 'unknown_decision',
            detail: `${mapping.id} targets decision '${target}', which is absent from the current plan revision`,
          });
        }
        continue;
      }
      if (target.startsWith('section:')) {
        const heading = target.slice('section:'.length).trim().toLowerCase();
        if (!heading || !sections.has(heading)) {
          problems.push({
            mappingId: mapping.id,
            target,
            code: 'unknown_section',
            detail: `${mapping.id} targets section '${target.slice('section:'.length).trim()}', which is absent from the current plan revision`,
          });
        }
        continue;
      }
      problems.push({
        mappingId: mapping.id,
        target,
        code: 'invalid_plan_target',
        detail: `${mapping.id} target '${target}' must be R-N, P-NNN, D-NNN, or section:<heading>`,
      });
    }
  }
  return problems;
}

export type RecordCurrentActivationAuditResult =
  | {
      ok: true;
      audit: PlanAudit;
      auditedPlanRevision: AuditedPlanRevision;
      /**
       * What this clean audit did to the plan's activation-repair filing. Present
       * on every success so "nothing was open" (`closed: null`) is a stated
       * reading rather than an absent field, and a failed close is visible to the
       * caller instead of only to the log.
       */
      repairReconciliation?: ActivationAuditRepairReconciliation;
      /** Atomic post-epoch seed result. Historical cohorts omit it and retain the
       * legacy non-fatal draft-clause derivation path. */
      barSeed?: TransactionalAcceptanceBarSeedSuccess | null;
      /** A changed started BAR is audit-able but not seed-able. The audit records
       * source coverage for the exact subject revision while the canonical
       * amendment path remains the only writer allowed to change rubric meaning
       * or clause projections. */
      barSeedPendingAmendment?: {
        rubricSlug: string;
        previousSubjectPlanRevision: number;
        currentSubjectPlanRevision: number;
        currentPlanContentHash: string;
        reason: 'acceptance_bar_source_changed';
      };
      /** The conversation/decision audit can land while the pinned rubric is
       * invalid, or while it still predates BAR adoption; the repair remains
       * explicit and no BAR state is rewritten. */
      barSeedPendingRepair?: {
        rubricSlug: string;
        currentSubjectPlanRevision: number;
        currentPlanContentHash: string;
        reason: 'acceptance_bar_rubric_invalid' | 'acceptance_bar_legacy_criteria_unmapped';
        problems: AcceptanceBarSeedProblem[];
      };
    }
  | {
      ok: false;
      error:
        | 'plan_busy'
        | 'plan_not_found'
        | 'activation_blocked'
        | 'plan_targets_invalid'
        | 'plan_revision_unavailable'
        | AcceptanceBarSeedCode;
      message: string;
      problems?: Array<ActivationAuditPlanTargetProblem | AcceptanceBarSeedProblem>;
      repairWorkItem?: string | null;
      repairFiling?: ActivationAuditRepairFiling;
    };

export interface AuditEntryValidationProblem {
  itemId: string;
  code:
    | 'missing_audited_sha'
    | 'invalid_audited_sha'
    | 'missing_audited_at'
    | 'invalid_audited_at'
    | 'missing_item_text_hash'
    | 'invalid_item_text_hash'
    | 'missing_blob_sha'
    | 'invalid_blob_sha';
  detail: string;
}

/**
 * Validate the shape that is about to be persisted.
 *
 * `plans:audit` is the normal producer and stamps these fields before calling the
 * store, but `recordPlanAudit` is also an internal write boundary. Keeping the
 * invariant here prevents another caller (or a stale deployed writer) from creating
 * a fresh row that looks current while carrying legacy-shaped entries. Existing
 * legacy entries are allowed only when `prepareAuditPassEntries` marks them with
 * `carriedFrom`; they retain their original, intentionally incomplete provenance.
 */
export function validatePersistedAuditEntries(items: AuditItemEntry[]): AuditEntryValidationProblem[] {
  const problems: AuditEntryValidationProblem[] = [];
  const hasOwn = (entry: AuditItemEntry, key: keyof AuditItemEntry): boolean =>
    Object.prototype.hasOwnProperty.call(entry, key);

  for (const item of items) {
    const hasProvenance = hasOwn(item, 'auditedSha') || hasOwn(item, 'auditedAt') || hasOwn(item, 'itemTextHash');
    const isLegacyCarry = !hasProvenance && Number.isInteger(item.carriedFrom) && (item.carriedFrom ?? 0) > 0;
    if (!isLegacyCarry) {
      if (!hasOwn(item, 'auditedSha')) {
        problems.push({
          itemId: item.itemId,
          code: 'missing_audited_sha',
          detail: `item '${item.itemId}' has no auditedSha provenance`,
        });
      } else if (item.auditedSha !== null && (typeof item.auditedSha !== 'string' || item.auditedSha.length < 7)) {
        problems.push({
          itemId: item.itemId,
          code: 'invalid_audited_sha',
          detail: `item '${item.itemId}' has an invalid auditedSha provenance value`,
        });
      }
      if (!hasOwn(item, 'auditedAt')) {
        problems.push({
          itemId: item.itemId,
          code: 'missing_audited_at',
          detail: `item '${item.itemId}' has no auditedAt provenance`,
        });
      } else if (typeof item.auditedAt !== 'string' || Number.isNaN(Date.parse(item.auditedAt))) {
        problems.push({
          itemId: item.itemId,
          code: 'invalid_audited_at',
          detail: `item '${item.itemId}' has an invalid auditedAt provenance value`,
        });
      }
      if (!hasOwn(item, 'itemTextHash')) {
        problems.push({
          itemId: item.itemId,
          code: 'missing_item_text_hash',
          detail: `item '${item.itemId}' has no itemTextHash provenance`,
        });
      } else if (typeof item.itemTextHash !== 'string' || !/^[0-9a-f]{64}$/i.test(item.itemTextHash)) {
        problems.push({
          itemId: item.itemId,
          code: 'invalid_item_text_hash',
          detail: `item '${item.itemId}' has an invalid itemTextHash provenance value`,
        });
      }
    }

    if (isLegacyCarry) continue;
    for (const citation of item.citations) {
      if (!isVerifyingCitation(citation)) continue;
      if (!citation.blobSha) {
        problems.push({
          itemId: item.itemId,
          code: 'missing_blob_sha',
          detail: `item '${item.itemId}' has a ${citation.kind} citation without blobSha`,
        });
      } else if (!/^[0-9a-f]{40}$/i.test(citation.blobSha)) {
        problems.push({
          itemId: item.itemId,
          code: 'invalid_blob_sha',
          detail: `item '${item.itemId}' has a ${citation.kind} citation with an invalid blobSha`,
        });
      }
    }
  }
  return problems;
}

/**
 * Append an audit pass. `audit_seq` is allocated in the INSERT itself
 * (`MAX(audit_seq)+1` over the same plan) rather than read-then-written, so two
 * concurrent audits of one plan cannot both compute the same sequence number. If
 * they race anyway the primary key rejects the loser, which is a retryable error
 * rather than a silently overwritten audit.
 */
type AuditSql = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

async function insertPlanAudit(
  input: RecordAuditInput,
  sql: AuditSql,
  workspaceId: string,
): Promise<PlanAudit> {
  const auditKind: PlanAuditKind = input.auditKind ?? 'completion';
  let items: AuditItemEntry[];
  let activation: ActivationAuditPayload | null;
  let auditedPlanRevision: AuditedPlanRevision | null;
  let auditedSha: string | null;
  let findings: AuditFinding[];
  if (input.auditKind === 'activation') {
    items = [];
    activation = input.activation;
    auditedPlanRevision = input.auditedPlanRevision;
    auditedSha = null;
    findings = [];
  } else {
    items = input.items;
    activation = null;
    auditedPlanRevision = null;
    auditedSha = input.auditedSha ?? null;
    findings = input.findings ?? [];
  }
  const provenanceProblems = validatePersistedAuditEntries(items);
  if (provenanceProblems.length > 0) {
    throw new Error(
      `plan audit provenance invalid: ${provenanceProblems.map((problem) => problem.detail).join('; ')}`,
    );
  }
  const rows = await sql<PlanAuditRow[]>`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, audited_sha,
       activation, audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash,
       items, findings, summary)
    SELECT ${workspaceId}, ${input.harnessSlug}, ${input.planSlug},
           COALESCE(MAX(a.audit_seq), 0) + 1,
           ${input.createdBy}, ${auditKind}, ${auditedSha},
           ${activation ? JSON.stringify(activation) : null}::text::jsonb,
           ${auditedPlanRevision?.id ?? null},
           ${auditedPlanRevision?.seq ?? null},
           ${auditedPlanRevision?.contentHash ?? null},
           -- postgres-js serializes an already-stringified parameter once more when its
           -- destination is typed jsonb. The intermediate text cast is load-bearing: a
           -- direct ::jsonb cast stores a jsonb STRING scalar (EI-21304616288919497).
           -- sql.json() is not portable to the getOrgPg client (EI-607).
           ${JSON.stringify(items)}::text::jsonb,
           ${JSON.stringify(findings)}::text::jsonb,
           ${input.summary ?? null}
      FROM harness_shared.plan_audits a
     WHERE a.workspace_id = ${workspaceId}
       AND a.plan_slug = ${input.planSlug}
    RETURNING plan_slug, harness_slug, audit_seq, created_by, created_at, audit_kind, audited_sha,
              activation, audited_plan_revision_id, audited_plan_revision_seq,
              audited_plan_content_hash, items, findings, summary`;
  return rowToAudit(rows[0]);
}

export async function recordPlanAudit(input: RecordAuditInput): Promise<PlanAudit> {
  // Preserve the pure fail-fast boundary: unit callers with malformed completion
  // entries must be rejected before getOrgPg is even resolved. insertPlanAudit
  // repeats this assertion because the atomic activation path calls it directly.
  if (input.auditKind !== 'activation') {
    const problems = validatePersistedAuditEntries(input.items);
    if (problems.length > 0) {
      throw new Error(`plan audit provenance invalid: ${problems.map((problem) => problem.detail).join('; ')}`);
    }
  }
  const { sql } = getOrgPg();
  return insertPlanAudit(input, sql as unknown as AuditSql, activeWorkspaceId());
}

/**
 * Record an activation audit against the exact current plan revision.
 *
 * The same advisory lock as every plans:* writer is held while current content,
 * plan targets, revision identity, and the audit insert are read/written. A
 * revision row must match BOTH current content hash and snapshot; the best-effort
 * revision writer can lag or fail, and silently attaching an older revision would
 * be worse than refusing with an actionable retry/repair error.
 */
export async function recordCurrentActivationAudit(
  input: RecordCurrentActivationAuditInput,
): Promise<RecordCurrentActivationAuditResult> {
  if (
    input.activation.unresolvedBlockers.length > 0 ||
    input.activation.mappings.some((mapping) => mapping.disposition === 'open')
  ) {
    const repairFiling = await ensureActivationAuditRepairFiling({
      workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug,
      planSlug: input.planSlug,
      activation: input.activation,
    });
    return {
      ok: false,
      error: 'activation_blocked',
      message:
        'Activation audit has unresolved blockers or open requirement mappings. Repair/map them before activation; no audit was recorded.',
      repairWorkItem: repairFiling.id,
      repairFiling,
    };
  }

  const lockKey = planAdvisoryLockKey(input.workspaceId, input.harnessSlug, input.planSlug);
  const { sql } = getOrgPg();
  let recorded: RecordCurrentActivationAuditResult;
  try {
    recorded = (await sql.begin(async (tx) => {
    const executor = tx as unknown as AuditSql;
    const lock = await executor<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_xact_lock(
        hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}), hashtext(${lockKey})
      ) AS ok`;
    if (!lock[0]?.ok) {
      return {
        ok: false as const,
        error: 'plan_busy' as const,
        message: `Plan '${input.planSlug}' is being edited. Retry the activation audit after that write commits.`,
      };
    }

    const plans = await executor<Array<{
      content: string;
      content_hash: string;
      title: string | null;
      status: string | null;
      version: number | string;
      acceptance_bar_epoch: number | string | null;
      acceptance_bar_cohort: 'post-epoch' | 'legacy-backfilled' | null;
      acceptance_bar_rubric_slug: string | null;
    }>>`
      SELECT content, content_hash, title, status, version,
             acceptance_bar_epoch, acceptance_bar_cohort, acceptance_bar_rubric_slug
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${input.harnessSlug}
         AND plan_slug = ${input.planSlug}`;
    const current = plans[0];
    if (!current) {
      return {
        ok: false as const,
        error: 'plan_not_found' as const,
        message: `Plan '${input.planSlug}' does not exist in harness '${input.harnessSlug}'.`,
      };
    }

    const problems = validateActivationAuditPlanTargets(input.activation, current.content);
    if (problems.length > 0) {
      return {
        ok: false as const,
        error: 'plan_targets_invalid' as const,
        message: `${problems.length} mapping target(s) do not exist in the current plan revision; no audit was recorded.`,
        problems,
      };
    }

    const revisions = await executor<
      Array<{ id: number | string; seq: number | string; content_hash: string }>
    >`
      SELECT id, seq, content_hash
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${input.workspaceId}
         AND harness_slug = ${input.harnessSlug}
         AND plan_slug = ${input.planSlug}
         AND content_hash = ${current.content_hash}
         AND content_snapshot = ${current.content}
       ORDER BY seq DESC
       LIMIT 1`;
    const revision = revisions[0];
    if (!revision) {
      return {
        ok: false as const,
        error: 'plan_revision_unavailable' as const,
        message:
          `The current bytes of plan '${input.planSlug}' have no matching plan_revisions row. ` +
          'Retry if an edit just committed; otherwise repair/backfill the revision spine before auditing.',
      };
    }

    const auditedPlanRevision: AuditedPlanRevision = {
      id: Number(revision.id),
      seq: Number(revision.seq),
      contentHash: revision.content_hash,
    };
    let barSeed: TransactionalAcceptanceBarSeedSuccess | null = null;
    let barSeedPendingAmendment:
      | NonNullable<Extract<RecordCurrentActivationAuditResult, { ok: true }>['barSeedPendingAmendment']>
      | undefined;
    let barSeedPendingRepair:
      | NonNullable<Extract<RecordCurrentActivationAuditResult, { ok: true }>['barSeedPendingRepair']>
      | undefined;
    if (current.acceptance_bar_epoch != null) {
      if (current.acceptance_bar_rubric_slug) {
        // A successful activation adopted the BARs against this exact snapshot.
        // Revision-ledger seq is allocated independently of harness_plans.version:
        // resolve the audit's identity, never use the BAR's version as a seq.
        const [previous] = await executor<Array<{
          content_snapshot: string; content_hash: string; subject_version: string | null;
          previous_activation: ActivationAuditPayload;
        }>>`
          SELECT r.content_snapshot, r.content_hash,
                 rubric.template_data->'barContract'->>'subjectPlanRevision' AS subject_version,
                 a.activation AS previous_activation
            FROM (
              SELECT activation, audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash
                FROM harness_shared.plan_audits
               WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug}
                 AND plan_slug = ${input.planSlug} AND audit_kind = 'activation'
               ORDER BY audit_seq DESC LIMIT 1
            ) a
            JOIN harness_shared.plan_revisions r
              ON r.id = a.audited_plan_revision_id AND r.seq = a.audited_plan_revision_seq
             AND r.content_hash = a.audited_plan_content_hash
             AND r.workspace_id = ${input.workspaceId} AND r.harness_slug = ${input.harnessSlug}
             AND r.plan_slug = ${input.planSlug}
            JOIN harness_shared.harness_plans rubric
              ON rubric.workspace_id = ${input.workspaceId} AND rubric.harness_slug = ${input.harnessSlug}
             AND rubric.plan_slug = ${current.acceptance_bar_rubric_slug}`;
        if (previous && hashPlanContent(previous.content_snapshot) === previous.content_hash) {
          const priorPending = previous.previous_activation?.barSeedPendingAmendment;
          const [previousSource, currentSource] = await Promise.all([
            acceptanceBarSourceFingerprint(previous.content_snapshot),
            acceptanceBarSourceFingerprint(current.content),
          ]);
          const rubricAlreadyPinsCurrentPlan = Number(previous.subject_version) === Number(current.version);
          if (
            priorPending?.rubricSlug === current.acceptance_bar_rubric_slug &&
            priorPending.previousSubjectPlanRevision === Number(previous.subject_version) &&
            priorPending.currentSubjectPlanRevision === Number(current.version) &&
            priorPending.currentPlanContentHash === current.content_hash
          ) {
            // The latest audit already recorded this exact semantic revision as
            // pending. Do not let its own snapshot become a new neutral baseline
            // that advances the still-stale rubric pin on a repeat call.
            barSeedPendingAmendment = priorPending;
          } else if (
            priorPending?.rubricSlug === current.acceptance_bar_rubric_slug &&
            priorPending.previousSubjectPlanRevision === Number(previous.subject_version) &&
            previousSource != null && previousSource === currentSource &&
            !rubricAlreadyPinsCurrentPlan
          ) {
            // A decision or Now edit after a pending semantic change must carry
            // that pending amendment forward. The last audit snapshot is already
            // the changed BAR source; treating this neutral edit as a fresh seed
            // would reconstruct the started rubric from incomplete plan prose.
            barSeedPendingAmendment = {
              ...priorPending,
              currentSubjectPlanRevision: Number(current.version),
              currentPlanContentHash: current.content_hash,
            };
          } else if (
            previous.subject_version != null &&
            previousSource != null &&
            currentSource != null &&
            previousSource !== currentSource &&
            !rubricAlreadyPinsCurrentPlan
          ) {
            // Audit authority and BAR-amendment authority are deliberately
            // separate. A semantic Requirements/map edit still needs a fresh
            // conversation audit against its exact plan revision, but that audit
            // must not rewrite a started rubric or project unapproved clauses.
            // Validate the authored BAR source now, record the audit below, and
            // leave the old subject pin in place so every lifecycle reader stays
            // blocked until rubrics:amend performs the reviewed atomic mutation.
            const requirements = parseRequirementBars(current.content);
            if (!requirements.ok) {
              return {
                ok: false as const,
                error: requirements.problems[0]!.code,
                message: `${requirements.problems.length} BAR requirement problem(s): ${requirements.problems.map((problem) => problem.detail).join('; ')}`,
              };
            }
            const mappings = parseBarMappings(
              current.content,
              new Set(requirements.bars.map((candidate) => candidate.barKey)),
            );
            if (!mappings.ok) {
              return {
                ok: false as const,
                error: mappings.problems[0]!.code,
                message: `${mappings.problems.length} BAR mapping problem(s): ${mappings.problems.map((problem) => problem.detail).join('; ')}`,
              };
            }
            barSeedPendingAmendment = {
              rubricSlug: current.acceptance_bar_rubric_slug,
              previousSubjectPlanRevision: Number(previous.subject_version),
              currentSubjectPlanRevision: Number(current.version),
              currentPlanContentHash: current.content_hash,
              reason: 'acceptance_bar_source_changed',
            };
          } else {
            if (!rubricAlreadyPinsCurrentPlan) {
              // This reuses the Requirements/map fingerprint and canonical BAR/hash
              // validation. Only the derived subject pin moves; METHOD, rubric version,
              // and existing evidence identities remain intact.
              await synchronizeAcceptanceBarSubjectRevision(tx, {
                workspaceId: input.workspaceId, harnessSlug: input.harnessSlug, planSlug: input.planSlug,
                previousBody: previous.content_snapshot, nextBody: current.content,
                previousVersion: Number(previous.subject_version), nextVersion: Number(current.version),
              });
            }
            // If rubrics:amend already pinned this plan revision, let the seed
            // reconcile work-item edges instead of recording a false pending
            // amendment against a reviewed contract.
          }
        }
      }
      if (!barSeedPendingAmendment) {
        const seeded = await seedAcceptanceBarsInTransaction({
          executor,
          workspaceId: input.workspaceId,
          harnessSlug: input.harnessSlug,
          planSlug: input.planSlug,
          planContent: current.content,
          planTitle: current.title,
          planStatus: current.status,
          planVersion: Number(current.version),
          adoptionEpoch: Number(current.acceptance_bar_epoch),
          cohort: current.acceptance_bar_cohort ?? 'post-epoch',
          actorId: input.createdBy,
          classRef: input.classRef,
          now: new Date(),
          // P-003/P-029 (review-system-rework-reduction-2026-09-23): activation is the
          // cheapest door to demand METHOD/check/layers — the plan is still a draft, so
          // the repair is a text edit, not a co-signed barHash-changing amendment.
          requireContractCompleteness: true,
        });
        // Catch-up may already have updated the derived pin in this transaction.
        if (!seeded.ok) {
          const repairProblems = seeded.problems.filter(
            (problem) => problem.repairable === 'invalid_template_data' ||
              problem.repairable === 'legacy_criteria_unmapped',
          );
          // A refusal is recordable only if EVERY problem is repairable. One
          // unrepairable problem alongside a repairable one still aborts, so this
          // never records an audit over a seed failure it has not accounted for.
          if (repairProblems.length > 0 && repairProblems.length === seeded.problems.length) {
            const first = repairProblems[0]!;
            barSeedPendingRepair = {
              rubricSlug: first.rubricSlug ?? current.acceptance_bar_rubric_slug ?? `acceptance-${input.planSlug}`,
              currentSubjectPlanRevision: Number(current.version),
              currentPlanContentHash: current.content_hash,
              reason: repairProblems.every((problem) => problem.repairable === 'legacy_criteria_unmapped')
                ? 'acceptance_bar_legacy_criteria_unmapped'
                : 'acceptance_bar_rubric_invalid',
              problems: repairProblems,
            };
          } else {
            throw new AcceptanceBarSeedAbort(seeded);
          }
        } else {
          barSeed = seeded;
        }
      }
    }
    const audit = await insertPlanAudit(
      {
        auditKind: 'activation',
        planSlug: input.planSlug,
        harnessSlug: input.harnessSlug,
        createdBy: input.createdBy,
        activation: {
          ...input.activation,
          ...(barSeedPendingAmendment ? { barSeedPendingAmendment } : {}),
          ...(barSeedPendingRepair ? { barSeedPendingRepair } : {}),
        },
        auditedPlanRevision,
        summary: input.summary ?? null,
      },
      executor,
      input.workspaceId,
    );
    return {
      ok: true as const,
      audit,
      auditedPlanRevision,
      barSeed,
      ...(barSeedPendingAmendment ? { barSeedPendingAmendment } : {}),
      ...(barSeedPendingRepair ? { barSeedPendingRepair } : {}),
    };
    })) as RecordCurrentActivationAuditResult;
  } catch (error) {
    if (error instanceof AcceptanceBarSeedAbort) return error.result;
    throw error;
  }
  if (!recorded.ok) return recorded;

  // POST-COMMIT on purpose, and only on the clean path. This audit landing IS
  // the event that clears the activation-repair condition, and it is the only
  // place both entry points (the plans:audit MCP handler and this writer)
  // provably converge — the handler reaches the store through here. Closing
  // inside the transaction would settle a filing for an audit that could still
  // roll back; sweeping for it later is what left 6 of 7 open filings stale.
  const repairReconciliation = await reconcileActivationAuditRepairFiling({
    workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug,
    planSlug: input.planSlug,
    auditSeq: recorded.audit.auditSeq,
  });
  if (repairReconciliation.error) {
    console.warn(
      `[plan-audits] activation-repair reconciliation for '${input.planSlug}' failed (non-fatal): ${repairReconciliation.error}`,
    );
  }
  return { ...recorded, repairReconciliation };
}
