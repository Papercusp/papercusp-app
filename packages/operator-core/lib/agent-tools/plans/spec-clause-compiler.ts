/**
 * Pure VAL-* → first-class spec-clause compiler/validator (P-003).
 *
 * This module deliberately performs no persistence and no rubric/gate work.
 * It turns legacy VAL blocks plus explicit structured enrichment into
 * deterministic clause candidates. Ambiguous legacy input remains a draft;
 * callers must never infer behavior classes, acceptance, or exemptions.
 */
import { createHash } from 'node:crypto';
import type { SpecBehaviorClass, SpecLifecycleStatus } from './spec-clauses-store';
import { extractAssertionCandidates, type PlanAssertionCandidate } from './val-assertions';

export interface SpecClauseExemption {
  justification?: string;
  provenance?: string;
  [key: string]: unknown;
}

/** Explicit human/tool enrichment; omitted fields are never guessed. */
export interface SpecClauseEnrichment {
  specId?: string;
  behavior?: string;
  behaviorClass?: SpecBehaviorClass;
  requiredEvidence?: string[];
  requiredTestLayers?: string[];
  mutationRequired?: boolean;
  lifecycleStatus?: SpecLifecycleStatus;
  exemption?: SpecClauseExemption | null;
  acceptanceRef?: string | null;
}

export type SpecCompilerDiagnosticSeverity = 'error' | 'warning';

export type SpecCompilerDiagnosticCode =
  | 'invalid-source-val-id'
  | 'invalid-spec-id'
  | 'duplicate-source-val-id'
  | 'duplicate-spec-id'
  | 'behavior-missing'
  | 'behavior-non-atomic'
  | 'behavior-not-falsifiable'
  | 'legacy-header-behavior-draft'
  | 'behavior-class-unresolved'
  | 'exemption-justification-missing'
  | 'exemption-provenance-missing'
  | 'exemption-without-exempt-status'
  | 'legacy-test-exemption-unjustified'
  | 'test-requirement-conflict'
  | 'enrichment-source-missing';

export interface SpecCompilerDiagnostic {
  code: SpecCompilerDiagnosticCode;
  severity: SpecCompilerDiagnosticSeverity;
  sourceValId: string;
  specId: string | null;
  message: string;
}

export interface CompiledSpecClauseCandidate {
  specId: string;
  sourceValId: string;
  planItemId: string;
  behavior: string;
  /** Null means review/enrichment is required before persistence. */
  behaviorClass: SpecBehaviorClass | null;
  requiredEvidence: string[];
  requiredTestLayers: string[];
  mutationRequired: boolean;
  lifecycleStatus: SpecLifecycleStatus;
  exemption: SpecClauseExemption | null;
  acceptanceRef: string | null;
  materializationReady: boolean;
  diagnostics: SpecCompilerDiagnostic[];
}

/** Semantic subset shared by compiler candidates and persisted current revisions. */
export interface SpecSetHashClause {
  specId: string;
  sourceValId: string | null;
  planItemId: string;
  behavior: string;
  behaviorClass: SpecBehaviorClass | null;
  requiredEvidence: readonly string[];
  requiredTestLayers: readonly string[];
  mutationRequired: boolean;
  lifecycleStatus: SpecLifecycleStatus;
  exemption: SpecClauseExemption | Record<string, unknown> | null;
  acceptanceRef: string | null;
}

export interface CompileSpecClausesOptions {
  itemIds?: Set<string>;
  enrichments?: Readonly<Record<string, SpecClauseEnrichment>>;
  previousSpecSetHash?: string;
}

export interface CompileSpecClausesResult {
  ok: boolean;
  candidates: CompiledSpecClauseCandidate[];
  diagnostics: SpecCompilerDiagnostic[];
  specSetHash: string;
  previousSpecSetHash?: string;
  invalidated: boolean;
}

const STRICT_VAL_ID_RE = /^VAL-[A-Za-z0-9._-]+$/;
const STRICT_SPEC_ID_RE = /^\S+$/;
const OBSERVABLE_VERB =
  '(?:accepts?|allows?|becomes?|creates?|deletes?|denies|emits?|fails?|includes?|omits?|records?|rejects?|remains?|returns?|shows?|starts?|stops?|updates?|writes?)';
const MULTI_OBSERVABLE_CONJUNCTION_RE = new RegExp(
  `\\b${OBSERVABLE_VERB}\\b[^.;\\n]{0,160}\\b(?:and|or)\\b[^.;\\n]{0,160}\\b${OBSERVABLE_VERB}\\b`,
  'i',
);
const MULTI_SUBJECT_SHARED_PREDICATE_RE =
  /\b(?:[^,.;]+,\s*){2,}(?:and|or)\s+[^,.;]+\s+(?:is|are|was|were|has|have|accepts?|allows?|becomes?|creates?|deletes?|denies|emits?|fails?|includes?|omits?|records?|rejects?|remains?|returns?|shows?|starts?|stops?|updates?|writes?)\b/i;
const ADDITIONAL_OBSERVABLE_VERB =
  '(?:dismiss(?:es)?|exists?|keeps?|promotes?|proven|reaches?|refuses?|renders?|stays?|turns?|carr(?:y|ies|ied|ying)|preserv(?:e|es|ed|ing)|mak(?:e|es|ing)|made)';
const EXTENDED_OBSERVABLE_VERB = '(?:' + OBSERVABLE_VERB + '|' + ADDITIONAL_OBSERVABLE_VERB + ')';
const EXTENDED_OBSERVABLE_PREDICATE_RE = new RegExp('\\b' + EXTENDED_OBSERVABLE_VERB + '\\b', 'i');
const MULTI_EXTENDED_CONJUNCTION_RE = new RegExp(
  '\\b' + EXTENDED_OBSERVABLE_VERB + '\\b[^.;\\n]*\\b(?:and|or)\\b[^.;\\n]*\\b' + EXTENDED_OBSERVABLE_VERB + '\\b',
  'i',
);
const MULTI_EXTENDED_WHILE_RE = new RegExp(
  '\\b' + EXTENDED_OBSERVABLE_VERB + '\\b[^.;\\n]*\\bwhile\\b[^.;\\n]*\\b' + EXTENDED_OBSERVABLE_VERB + '\\b',
  'i',
);
const INDEPENDENT_CLAUSE_SUBJECT_RE =
  /^(?:a|an|the|both|each|every|this|that|these|those|class-[a-z0-9-]+)\b/i;
const IMPLEMENTATION_PRESENCE_RE =
  /\b(?:(?:is|are|was|were)\s+)?(?:present|implemented|exists?)\s+in\s+(?:the\s+)?(?:current\s+)?(?:source[ -]code|code(?:base)?|repository|repo|tree|implementation)\b/i;
const IMPLEMENTATION_CONTAINS_RE =
  /\b(?:the\s+)?(?:current\s+)?(?:source[ -]code|code(?:base)?|repository|repo|tree|implementation)\s+(?:contains?|includes?|has)\b/i;
const GENERIC_NON_FALSIFIABLE_RE =
  /^(?:(?:it|this|the (?:feature|flow|system))\s+)?(?:works|behaves|functions)(?:\s+(?:correctly|properly|as expected))?[.!]?$/i;
const PLACEHOLDER_RE = /\b(?:TBD|TODO|to be determined|as appropriate|somehow)\b/i;

/** Normalize Markdown/whitespace presentation without erasing semantics. */
export function normalizeSpecSemanticText(value: string): string {
  return value
    .trim()
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/[\t\r\n ]+/g, ' ')
    .trim();
}

function normalizeSet(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(normalizeSpecSemanticText).filter(Boolean))].sort();
}

function normalizeSemanticValue(value: unknown): unknown {
  if (typeof value === 'string') return normalizeSpecSemanticText(value);
  if (Array.isArray(value)) return value.map(normalizeSemanticValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalizeSemanticValue(nested)]),
    );
  }
  return value;
}

function canonicalCandidate(candidate: SpecSetHashClause): Record<string, unknown> {
  return {
    specId: candidate.specId,
    sourceValId: candidate.sourceValId,
    planItemId: candidate.planItemId,
    behavior: normalizeSpecSemanticText(candidate.behavior),
    behaviorClass: candidate.behaviorClass,
    requiredEvidence: normalizeSet(candidate.requiredEvidence),
    requiredTestLayers: normalizeSet(candidate.requiredTestLayers),
    mutationRequired: candidate.mutationRequired,
    lifecycleStatus: candidate.lifecycleStatus,
    exemption: normalizeSemanticValue(candidate.exemption),
    acceptanceRef: candidate.acceptanceRef ? normalizeSpecSemanticText(candidate.acceptanceRef) : null,
  };
}

/** Hash only semantic clause content; source order and Markdown styling do not matter. */
export function computeSpecSetHash(candidates: readonly SpecSetHashClause[]): string {
  const semanticRows = candidates
    .map(canonicalCandidate)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(semanticRows)).digest('hex');
}

function deriveSpecId(sourceValId: string): string {
  return sourceValId.startsWith('VAL-') ? `SPEC-${sourceValId.slice('VAL-'.length)}` : `SPEC-${sourceValId}`;
}

function hasIndependentCommaClauseSeries(behavior: string): boolean {
  const clauses = behavior.split(',').filter((fragment) => {
    const clause = fragment.trim().replace(/^(?:and|or|while)\s+/i, '');
    return INDEPENDENT_CLAUSE_SUBJECT_RE.test(clause) && EXTENDED_OBSERVABLE_PREDICATE_RE.test(clause);
  });
  return clauses.length > 1;
}

export function specBehaviorNonAtomicReason(rawBehavior: string): string | null {
  const lines = rawBehavior
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) return 'behavior contains multiple non-empty lines';
  const behavior = normalizeSpecSemanticText(rawBehavior);
  if (/;\s*\S/.test(behavior)) return 'behavior contains multiple semicolon-separated assertions';
  if (/[.!?]\s+(?=[A-Z0-9])/.test(behavior)) return 'behavior contains multiple sentences';
  if (MULTI_SUBJECT_SHARED_PREDICATE_RE.test(behavior)) {
    return 'behavior groups multiple subjects under one predicate';
  }
  if (
    MULTI_OBSERVABLE_CONJUNCTION_RE.test(behavior) ||
    MULTI_EXTENDED_CONJUNCTION_RE.test(behavior) ||
    MULTI_EXTENDED_WHILE_RE.test(behavior) ||
    hasIndependentCommaClauseSeries(behavior)
  ) {
    return 'behavior joins multiple independently observable outcomes';
  }
  return null;
}

export function specBehaviorImplementationPresenceReason(rawBehavior: string): string | null {
  const behavior = normalizeSpecSemanticText(rawBehavior);
  if (IMPLEMENTATION_PRESENCE_RE.test(behavior) || IMPLEMENTATION_CONTAINS_RE.test(behavior)) {
    return 'behavior asserts source-code presence instead of an observable outcome';
  }
  return null;
}

export function specBehaviorNonFalsifiableReason(rawBehavior: string): string | null {
  const behavior = normalizeSpecSemanticText(rawBehavior);
  if (!behavior) return 'behavior is empty';
  if (PLACEHOLDER_RE.test(behavior)) return 'behavior contains placeholder or discretionary wording';
  const implementationPresence = specBehaviorImplementationPresenceReason(behavior);
  if (implementationPresence) return implementationPresence;
  if (GENERIC_NON_FALSIFIABLE_RE.test(behavior)) return 'behavior states only that something works';
  return null;
}

function normalizedExemption(exemption: SpecClauseExemption | null | undefined): SpecClauseExemption | null {
  if (!exemption) return null;
  return {
    ...exemption,
    ...(typeof exemption.justification === 'string' ? { justification: exemption.justification.trim() } : {}),
    ...(typeof exemption.provenance === 'string' ? { provenance: exemption.provenance.trim() } : {}),
  };
}

function compileCandidate(
  source: PlanAssertionCandidate,
  enrichment: SpecClauseEnrichment | undefined,
): CompiledSpecClauseCandidate {
  const diagnostics: SpecCompilerDiagnostic[] = [];
  const specId = enrichment?.specId?.trim() || deriveSpecId(source.valId);
  const explicitBehavior = enrichment?.behavior?.trim();
  const verifyBehavior = source.verifyText?.trim();
  const headerBehavior = source.headerText?.trim();
  const rawBehavior = explicitBehavior || verifyBehavior || headerBehavior || '';
  const behavior = normalizeSpecSemanticText(rawBehavior);
  const behaviorClass = enrichment?.behaviorClass ?? null;
  const exemption = normalizedExemption(enrichment?.exemption);
  let lifecycleStatus: SpecLifecycleStatus = enrichment?.lifecycleStatus ?? 'draft';

  const add = (code: SpecCompilerDiagnosticCode, severity: SpecCompilerDiagnosticSeverity, message: string) =>
    diagnostics.push({ code, severity, sourceValId: source.valId, specId, message });

  if (!STRICT_VAL_ID_RE.test(source.valId)) {
    add('invalid-source-val-id', 'error', `${source.valId} is not a canonical VAL-* id`);
  }
  if (!specId || !STRICT_SPEC_ID_RE.test(specId)) {
    add('invalid-spec-id', 'error', `${specId || '(empty)'} is not a valid stable spec id`);
  }
  if (!behavior) {
    add('behavior-missing', 'error', 'legacy assertion has neither explicit behavior, Verify text, nor header text');
    lifecycleStatus = 'draft';
  } else {
    const atomicity = specBehaviorNonAtomicReason(rawBehavior);
    if (atomicity) add('behavior-non-atomic', 'error', atomicity);
    const falsifiability = specBehaviorNonFalsifiableReason(rawBehavior);
    if (falsifiability) add('behavior-not-falsifiable', 'error', falsifiability);
  }

  if (!explicitBehavior && !verifyBehavior && headerBehavior) {
    add(
      'legacy-header-behavior-draft',
      'warning',
      'legacy header text was preserved as behavior but remains draft until explicitly reviewed',
    );
    if (!enrichment?.lifecycleStatus) lifecycleStatus = 'draft';
  }
  if (!behaviorClass) {
    add(
      'behavior-class-unresolved',
      'warning',
      'behaviorClass is intentionally unresolved; review must supply it before persistence',
    );
    lifecycleStatus = 'draft';
  }

  const hasJustification = typeof exemption?.justification === 'string' && exemption.justification.length > 0;
  const hasProvenance = typeof exemption?.provenance === 'string' && exemption.provenance.length > 0;
  if (lifecycleStatus === 'exempt') {
    if (!hasJustification) {
      add('exemption-justification-missing', 'error', 'exempt clauses require a non-empty justification');
    }
    if (!hasProvenance) {
      add('exemption-provenance-missing', 'error', 'exempt clauses require explicit provenance');
    }
  } else if (exemption) {
    add('exemption-without-exempt-status', 'error', 'exemption metadata is only valid for lifecycleStatus=exempt');
  }

  if (source.requiresTest === false && lifecycleStatus !== 'exempt') {
    add(
      'legacy-test-exemption-unjustified',
      'error',
      'RequiresTest:false does not waive behavior; supply an explicit justified exemption or reconcile the clause',
    );
    lifecycleStatus = 'draft';
  }
  if (source.requiresTest === false && (enrichment?.requiredTestLayers?.length ?? 0) > 0) {
    add('test-requirement-conflict', 'error', 'legacy RequiresTest:false conflicts with explicit requiredTestLayers');
  }

  const requiredEvidence = enrichment?.requiredEvidence
    ? normalizeSet(enrichment.requiredEvidence)
    : normalizeSet(source.evidenceText ? [source.evidenceText] : []);
  const requiredTestLayers = normalizeSet(enrichment?.requiredTestLayers);
  const candidate: CompiledSpecClauseCandidate = {
    specId,
    sourceValId: source.valId,
    planItemId: source.itemId,
    behavior,
    behaviorClass,
    requiredEvidence,
    requiredTestLayers,
    mutationRequired: enrichment?.mutationRequired ?? false,
    lifecycleStatus,
    exemption,
    acceptanceRef: enrichment?.acceptanceRef?.trim() || null,
    materializationReady: false,
    diagnostics,
  };
  candidate.materializationReady =
    candidate.behaviorClass !== null && !diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return candidate;
}

function addDuplicateDiagnostics(
  candidates: CompiledSpecClauseCandidate[],
  field: 'sourceValId' | 'specId',
  code: 'duplicate-source-val-id' | 'duplicate-spec-id',
): void {
  const counts = new Map<string, number>();
  for (const candidate of candidates) counts.set(candidate[field], (counts.get(candidate[field]) ?? 0) + 1);
  for (const candidate of candidates) {
    if ((counts.get(candidate[field]) ?? 0) < 2) continue;
    candidate.diagnostics.push({
      code,
      severity: 'error',
      sourceValId: candidate.sourceValId,
      specId: candidate.specId,
      message: `${field} ${candidate[field]} occurs more than once in the compiled spec set`,
    });
    candidate.materializationReady = false;
  }
}

/** Compile a plan's inline VAL blocks into deterministic first-class clause candidates. */
export function compileSpecClauses(rawPlan: string, options: CompileSpecClausesOptions = {}): CompileSpecClausesResult {
  const enrichments = options.enrichments ?? {};
  const sources = extractAssertionCandidates(rawPlan, options.itemIds);
  const candidates = sources.map((source) => compileCandidate(source, enrichments[source.valId]));

  addDuplicateDiagnostics(candidates, 'sourceValId', 'duplicate-source-val-id');
  addDuplicateDiagnostics(candidates, 'specId', 'duplicate-spec-id');

  const diagnostics = candidates.flatMap((candidate) => candidate.diagnostics);
  const seenValIds = new Set(sources.map((source) => source.valId));
  for (const sourceValId of Object.keys(enrichments).sort()) {
    if (seenValIds.has(sourceValId)) continue;
    diagnostics.push({
      code: 'enrichment-source-missing',
      severity: 'warning',
      sourceValId,
      specId: enrichments[sourceValId]?.specId ?? null,
      message: `enrichment has no matching inline ${sourceValId} assertion`,
    });
  }

  candidates.sort((a, b) => JSON.stringify(canonicalCandidate(a)).localeCompare(JSON.stringify(canonicalCandidate(b))));
  diagnostics.sort((a, b) =>
    `${a.sourceValId}\u0000${a.specId ?? ''}\u0000${a.code}`.localeCompare(
      `${b.sourceValId}\u0000${b.specId ?? ''}\u0000${b.code}`,
    ),
  );
  const specSetHash = computeSpecSetHash(candidates);
  return {
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
    candidates,
    diagnostics,
    specSetHash,
    ...(options.previousSpecSetHash !== undefined ? { previousSpecSetHash: options.previousSpecSetHash } : {}),
    invalidated: options.previousSpecSetHash !== undefined && options.previousSpecSetHash !== specSetHash,
  };
}
