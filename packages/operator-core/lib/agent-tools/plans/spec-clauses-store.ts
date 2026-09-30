/** Canonical first-class plan spec clause storage (P-002 / D-001..D-003). */
import { createHash } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import { pgTimestampToIso, pgTimestampToIsoOrNull } from '../../pg-timestamp';
import { resolveSpecScopeSlug } from './adhoc-spec-scope';
import { resolvePlanScope } from './source';

export const SPEC_BEHAVIOR_CLASSES = [
  'happy-path',
  'boundary',
  'failure',
  'authorization',
  'concurrency',
  'lifecycle',
  'observability',
  'migration-data-integrity',
  'non-automated',
] as const;
export type SpecBehaviorClass = (typeof SPEC_BEHAVIOR_CLASSES)[number];

export const SPEC_LIFECYCLE_STATUSES = ['draft', 'accepted', 'active', 'superseded', 'exempt', 'retired'] as const;
export type SpecLifecycleStatus = (typeof SPEC_LIFECYCLE_STATUSES)[number];

export function isEnforceableSpecLifecycle(status: SpecLifecycleStatus): boolean {
  return status === 'accepted' || status === 'active';
}

/** Stable ids shared by canonical spec obligations and immutable evidence bindings. */
export const SPEC_PROOF_OBLIGATION_ID_RE = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
export const SPEC_CAUSAL_PAIRING_MODES = ['one-to-one'] as const;
export type SpecCausalPairingMode = (typeof SPEC_CAUSAL_PAIRING_MODES)[number];

/**
 * D-016: the concrete observation that proves THIS clause violated.
 *
 * Falsifiability was already ENFORCED here (mutationRequired proves the covering
 * test can fail; behaviorClass forces breaking-condition clauses) but never
 * DECLARED — no field said what a violation would actually look like. Declaring it
 * makes adequacy mechanical (a test is adequate iff it can produce this
 * observation) and structurally filters vacuous clauses: no falsifier can be
 * written for "the system is robust".
 */
export interface SpecClauseFalsifier {
  /** What you would SEE if the promise were broken — not a restatement of the promise. */
  observation: string;
  /** How to produce that observation: the probe, mutation, or input that elicits it. */
  probeMethod?: string;
  /** Canonical acceptance scenarios every adequate proof cohort must execute successfully. */
  requiredScenarios?: string[];
  /** Require one immutable negative and one repaired recurrence binding per causal pair id. */
  causalPairing?: SpecCausalPairingMode;
}

/** Write-side shape: JSON callers may spell an absent probeMethod as an explicit null. */
export interface SpecClauseFalsifierWrite {
  observation: string;
  probeMethod?: string | null;
  requiredScenarios?: string[] | null;
  causalPairing?: SpecCausalPairingMode | null;
}

/** Immutable provenance/pin proving this clause is a projection of one canonical
 * acceptance BAR revision, not an independently editable promise. */
export interface SpecClauseBarPin {
  barKey: string;
  barHash: string;
  barSetHash: string;
  rubricSlug: string;
  rubricRevision: number;
  evidencePlane: 'tree' | 'deployed' | 'live';
}

export interface SpecClauseWrite {
  harnessSlug?: string;
  /**
   * The plan this clause belongs to. OPTIONAL as of P-022: omit it to author a clause for
   * an ad-hoc work-item that belongs to no plan, and it is scoped to
   * `ADHOC_WORK_ITEM_SPEC_SCOPE` instead (see `adhoc-spec-scope.ts` and D-018 for why the
   * scope is resolved rather than the column made nullable — `plan_slug` is a PRIMARY KEY
   * column in every table of this chain, so it can never hold NULL).
   */
  planSlug?: string;
  specId: string;
  expectedRevision: number;
  sourceValId?: string | null;
  /**
   * The owning item label. Stays a `P-NNN` even in the ad-hoc scope —
   * `plan_spec_clause_revisions_plan_item_id_check` enforces `^P-[0-9]{3,}$` at the
   * database, so a work-item id cannot stand in however natural that reads. In the ad-hoc
   * scope its `plan_items` row is created lazily; per-work-item identity rides on `specId`
   * and on `work_item_spec_revision_edges.work_item_id`, not on this label.
   */
  planItemId: string;
  behavior: string;
  behaviorClass: SpecBehaviorClass;
  requiredEvidence?: string[];
  requiredTestLayers?: string[];
  mutationRequired?: boolean;
  lifecycleStatus: SpecLifecycleStatus;
  supersedes?: { specId: string; revision: number } | null;
  exemption?: Record<string, unknown> | null;
  falsifier?: SpecClauseFalsifierWrite | null;
  acceptanceRef?: string | null;
  sourceBar?: SpecClauseBarPin | null;
  actorId: string;
}

export interface SpecClauseRevision {
  planSlug: string;
  specId: string;
  sourceValId: string | null;
  currentRevision: number;
  revision: number;
  planItemId: string;
  behavior: string;
  behaviorClass: SpecBehaviorClass;
  requiredEvidence: string[];
  requiredTestLayers: string[];
  mutationRequired: boolean;
  lifecycleStatus: SpecLifecycleStatus;
  supersedes: { specId: string; revision: number } | null;
  exemption: Record<string, unknown> | null;
  /** D-016 declaration; NULL means undeclared, which is a gradeable gap — not a passing clause. */
  falsifier: SpecClauseFalsifier | null;
  contentHash: string;
  createdBy: string;
  createdAt: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
  acceptanceRef: string | null;
  /** Absent/null for historical rows written before the BAR projection pin. */
  sourceBar?: SpecClauseBarPin | null;
}

export type SetSpecClauseResult =
  | {
      status: 'created' | 'revised';
      specId: string;
      revision: number;
      contentHash: string;
      /** Set on a lifecycle-only revision: live bindings carried from the prior revision (WI-10002889). */
      evidenceCarriedForward?: number;
    }
  | { status: 'unchanged'; specId: string; revision: number; contentHash: string }
  | { status: 'conflict'; specId: string; expectedRevision: number; actualRevision: number }
  | { status: 'source_alias_immutable'; specId: string; sourceValId: string | null }
  | {
      status: 'source_alias_conflict';
      specId: string;
      sourceValId: string;
      conflictingPlanSlug: string;
      conflictingSpecId: string;
    }
  | { status: 'falsifier_invalid'; specId: string; reason: FalsifierIssue }
  | { status: 'bar_pin_invalid'; specId: string; reason: string }
  | { status: 'plan_not_found'; specId: string; planSlug: string }
  | { status: 'plan_item_not_found'; specId: string; planItemId: string }
  | { status: 'supersedes_not_found'; specId: string; supersedes: { specId: string; revision: number } };

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalJson(nested)]),
    );
  }
  return value;
}

function normalizedSet(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(Boolean))].sort();
}

export type FalsifierIssue =
  | 'not_an_object'
  | 'observation_blank'
  | 'probe_method_blank'
  | 'required_scenarios_not_array'
  | 'required_scenarios_empty'
  | 'required_scenario_invalid'
  | 'required_scenario_duplicate'
  | 'causal_pairing_invalid';

/**
 * Structured refusal for a MALFORMED declaration — never for an ABSENT one.
 *
 * Undeclared (undefined/null) is legal and reports honestly as a gradeable gap
 * (D-016 assigns concreteness grading to P-004, hard enforcement to P-013). But a
 * caller who supplied an object and got it silently dropped would believe they had
 * declared a falsifier when the row says nothing — the exact "reads as declared
 * while saying nothing" failure the column's blank-vs-NULL rule exists to prevent.
 * The DB CHECK is the backstop; this is the structured answer, in the same idiom as
 * this store's other refusals rather than an opaque 23514.
 */
function falsifierIssueOf(value: SpecClauseWrite['falsifier']): FalsifierIssue | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'not_an_object';
  const observation = typeof value.observation === 'string' ? value.observation.trim() : '';
  if (!observation) return 'observation_blank';
  const probe = value.probeMethod;
  if (probe !== undefined && probe !== null && (typeof probe !== 'string' || !probe.trim())) {
    return 'probe_method_blank';
  }
  const scenarios = value.requiredScenarios;
  if (scenarios !== undefined && scenarios !== null) {
    if (!Array.isArray(scenarios)) return 'required_scenarios_not_array';
    if (scenarios.length === 0) return 'required_scenarios_empty';
    const normalized = scenarios.map((scenario) => (typeof scenario === 'string' ? scenario.trim() : ''));
    if (normalized.some((scenario) => !SPEC_PROOF_OBLIGATION_ID_RE.test(scenario))) {
      return 'required_scenario_invalid';
    }
    if (new Set(normalized).size !== normalized.length) return 'required_scenario_duplicate';
  }
  if (
    value.causalPairing !== undefined &&
    value.causalPairing !== null &&
    !SPEC_CAUSAL_PAIRING_MODES.includes(value.causalPairing)
  ) {
    return 'causal_pairing_invalid';
  }
  return null;
}

function normalizedFalsifier(value: SpecClauseWrite['falsifier']): SpecClauseFalsifier | null {
  if (falsifierIssueOf(value) !== null || !value) return null;
  const observation = value.observation.trim();
  const probeMethod = typeof value.probeMethod === 'string' ? value.probeMethod.trim() : '';
  const requiredScenarios = normalizedSet(value.requiredScenarios ?? undefined);
  return {
    observation,
    ...(probeMethod ? { probeMethod } : {}),
    ...(requiredScenarios.length > 0 ? { requiredScenarios } : {}),
    ...(value.causalPairing ? { causalPairing: value.causalPairing } : {}),
  };
}

function barPinIssueOf(value: SpecClauseWrite['sourceBar']): string | null {
  if (value === undefined || value === null) return null;
  if (!value.barKey.trim()) return 'bar_key_blank';
  if (!/^[a-f0-9]{64}$/.test(value.barHash)) return 'bar_hash_invalid';
  if (!/^[a-f0-9]{64}$/.test(value.barSetHash)) return 'bar_set_hash_invalid';
  if (!value.rubricSlug.trim()) return 'rubric_slug_blank';
  if (!Number.isInteger(value.rubricRevision) || value.rubricRevision <= 0) return 'rubric_revision_invalid';
  if (!['tree', 'deployed', 'live'].includes(value.evidencePlane)) return 'evidence_plane_invalid';
  return null;
}

function canonicalWrite(input: SpecClauseWrite) {
  const falsifier = normalizedFalsifier(input.falsifier);
  return {
    planItemId: input.planItemId,
    behavior: input.behavior.trim(),
    behaviorClass: input.behaviorClass,
    requiredEvidence: normalizedSet(input.requiredEvidence),
    requiredTestLayers: normalizedSet(input.requiredTestLayers),
    mutationRequired: input.mutationRequired ?? false,
    lifecycleStatus: input.lifecycleStatus,
    supersedes: input.supersedes ?? null,
    exemption: input.exemption ?? null,
    // ABSENT when undeclared, deliberately not `falsifier: null`. A null key would
    // change the canonical JSON of every clause written before D-016, re-hashing the
    // whole corpus so each one's first no-op re-write returns `revised` and appends a
    // spurious revision. Declaring one still moves the hash (absent -> present), which
    // is the point: revising a falsifier appends a NEW immutable revision rather than
    // mutating a standing promise in place.
    ...(falsifier ? { falsifier } : {}),
    acceptanceRef: input.acceptanceRef?.trim() || null,
    ...(input.sourceBar
      ? {
          sourceBar: {
            barKey: input.sourceBar.barKey.trim(),
            barHash: input.sourceBar.barHash.trim(),
            barSetHash: input.sourceBar.barSetHash.trim(),
            rubricSlug: input.sourceBar.rubricSlug.trim(),
            rubricRevision: input.sourceBar.rubricRevision,
            evidencePlane: input.sourceBar.evidencePlane,
          },
        }
      : {}),
  };
}

export function specClauseContentHash(input: SpecClauseWrite): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(canonicalWrite(input))))
    .digest('hex');
}

/**
 * WI-10002889 (R-1) + WI-10003763: does this write differ from the stored prior revision ONLY in
 * acceptance provenance, i.e. `lifecycleStatus` and/or `acceptanceRef`? Neither is part of what a
 * proof measures (behavior, falsifier, layers, evidence, BAR pin), so proof bound to the prior
 * revision still proves this one. Both stay in the content hash on purpose (a promotion, or a
 * restored acceptance ref, must remain an auditable immutable revision), so re-hash THIS write
 * under the prior provenance and compare it with the prior revision's stored hash: equal means
 * nothing else moved. An omitted `sourceBar` rides the prior pin forward (see setSpecClause), so
 * that variant is tried too. A hash that differs for any other reason (a canonicalization change,
 * a real edit) answers false, which is the safe direction: proof is then re-run rather than carried.
 */
export function differsOnlyInAcceptanceProvenance(
  input: SpecClauseWrite,
  prior: { lifecycleStatus: SpecLifecycleStatus; acceptanceRef: string | null },
  priorBarPin: SpecClauseBarPin | null,
  priorContentHash: string,
): boolean {
  const asPrior: SpecClauseWrite = {
    ...input,
    lifecycleStatus: prior.lifecycleStatus,
    acceptanceRef: prior.acceptanceRef,
  };
  if (specClauseContentHash(asPrior) === priorContentHash) return true;
  return (
    input.sourceBar === undefined &&
    priorBarPin !== null &&
    specClauseContentHash({ ...asPrior, sourceBar: priorBarPin }) === priorContentHash
  );
}

interface IdentityRow {
  source_val_id: string | null;
  current_revision: number;
  // Carried from the CURRENT revision so an omitted `sourceBar` can ride its
  // lineage forward instead of writing NULL. Optional because the post-insert
  // race re-read selects only the identity columns.
  source_bar_key?: string | null;
  source_bar_hash?: string | null;
  source_bar_set_hash?: string | null;
  source_rubric_slug?: string | null;
  source_rubric_revision?: number | string | null;
  evidence_plane?: string | null;
  // WI-10003763: rides forward on omission, like the BAR pin above.
  acceptance_ref?: string | null;
}

interface AliasIdentityRow {
  plan_slug: string;
  spec_id: string;
}

export type SpecClauseSql = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/** Existing-transaction seam used by activation seeding/amendment so rubric,
 * projection, audit, and subject-plan pins commit or roll back together. */
export interface SetSpecClauseTransaction {
  executor: SpecClauseSql;
  workspaceId: string;
  harnessSlug: string;
}

/** Append one immutable revision under an optimistic expectedRevision CAS. */
export async function setSpecClause(
  input: SpecClauseWrite,
  transaction?: SetSpecClauseTransaction,
): Promise<SetSpecClauseResult> {
  const falsifierIssue = falsifierIssueOf(input.falsifier);
  if (falsifierIssue) {
    return { status: 'falsifier_invalid', specId: input.specId, reason: falsifierIssue };
  }
  const barPinIssue = barPinIssueOf(input.sourceBar);
  if (barPinIssue) {
    return { status: 'bar_pin_invalid', specId: input.specId, reason: barPinIssue };
  }
  const scope = transaction ?? (await resolvePlanScope({ harnessSlug: input.harnessSlug }));
  const normalized = canonicalWrite(input);
  const falsifier = normalizedFalsifier(input.falsifier);
  const contentHash = specClauseContentHash(input);

  const write = async (tx: SpecClauseSql): Promise<SetSpecClauseResult> => {
    // P-022 / D-018: a clause for a work-item that belongs to no plan is authored into the
    // harness's shared ad-hoc spec scope. Resolved BEFORE the lock and the ownership check
    // below, because that check is exactly what the scope has to exist to satisfy.
    const planSlug = await resolveSpecScopeSlug(
      tx as never,
      scope.workspaceId,
      scope.harnessSlug,
      input.planSlug,
      normalized.planItemId,
    );
    const lockKey = `${scope.workspaceId}:${scope.harnessSlug}:${planSlug}:${input.specId}`;
    await tx`SELECT pg_advisory_xact_lock(hashtext('plan_spec_clause'), hashtext(${lockKey}))`;

    // The optional VAL alias has harness-wide uniqueness. Lock it independently
    // from the spec identity so two different specs racing for one alias resolve
    // to a structured conflict rather than an opaque 23505.
    if (input.sourceValId) {
      const aliasKey = `${scope.workspaceId}:${scope.harnessSlug}:${input.sourceValId}`;
      await tx`SELECT pg_advisory_xact_lock(hashtext('plan_spec_clause_alias'), hashtext(${aliasKey}))`;
    }

    const ownership = await tx<{ plan_exists: boolean; item_exists: boolean }[]>`
      SELECT
        EXISTS (
          SELECT 1 FROM harness_shared.harness_plans
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND plan_slug = ${planSlug}
        ) AS plan_exists,
        EXISTS (
          SELECT 1 FROM harness_shared.plan_items
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND plan_slug = ${planSlug}
             AND item_id = ${normalized.planItemId}
        ) AS item_exists`;
    if (!ownership[0]?.plan_exists) {
      return { status: 'plan_not_found', specId: input.specId, planSlug: planSlug };
    }
    if (!ownership[0]?.item_exists) {
      return { status: 'plan_item_not_found', specId: input.specId, planItemId: normalized.planItemId };
    }

    if (normalized.supersedes) {
      const target = await tx<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM harness_shared.plan_spec_clause_revisions
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND plan_slug = ${planSlug}
             AND spec_id = ${normalized.supersedes.specId}
             AND revision = ${normalized.supersedes.revision}
        ) AS exists`;
      if (!target[0]?.exists) {
        return {
          status: 'supersedes_not_found',
          specId: input.specId,
          supersedes: normalized.supersedes,
        };
      }
    }

    const identities = await tx<IdentityRow[]>`
      SELECT c.source_val_id, c.current_revision,
             r.source_bar_key, r.source_bar_hash, r.source_bar_set_hash,
             r.source_rubric_slug, r.source_rubric_revision, r.evidence_plane,
             r.acceptance_ref
        FROM harness_shared.plan_spec_clauses c
        LEFT JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id = c.workspace_id
         AND r.harness_slug = c.harness_slug
         AND r.plan_slug = c.plan_slug
         AND r.spec_id = c.spec_id
         AND r.revision = c.current_revision
       WHERE c.workspace_id = ${scope.workspaceId}
         AND c.harness_slug = ${scope.harnessSlug}
         AND c.plan_slug = ${planSlug}
         AND c.spec_id = ${input.specId}
       FOR UPDATE OF c`;
    const identity = identities[0];
    const actualRevision = Number(identity?.current_revision ?? 0);
    if (input.expectedRevision !== actualRevision) {
      return { status: 'conflict', specId: input.specId, expectedRevision: input.expectedRevision, actualRevision };
    }
    if (identity && input.sourceValId !== undefined && (input.sourceValId ?? null) !== identity.source_val_id) {
      return { status: 'source_alias_immutable', specId: input.specId, sourceValId: identity.source_val_id };
    }

    // `sourceBar` is IMMUTABLE PROVENANCE, not an editable attribute, so an OMITTED
    // pin must ride the prior revision forward rather than land as NULL. Writing NULL
    // there is silent lineage loss: `acceptance_ref` survives (the caller passes it) so
    // the clause still READS as bar-linked in reports, while `source_bar_key` — the one
    // column acceptance-bar amendment joins on — is gone. The damaged clauses then go
    // invisible to the amendment, which asks for expectedRevision 0 against a row that
    // is really at N, conflicts, and permanently wedges that plan's BAR contract.
    // An EXPLICIT `null` still means unlink, but for a generated AUTO-BAR-* projection
    // that is only legitimate on a supersede — the shape reviewed remaps already use.
    const priorBarPin: SpecClauseBarPin | null =
      identity?.source_bar_key &&
      identity.source_bar_hash &&
      identity.source_bar_set_hash &&
      identity.source_rubric_slug &&
      identity.source_rubric_revision != null &&
      identity.evidence_plane
        ? {
            barKey: identity.source_bar_key,
            barHash: identity.source_bar_hash,
            barSetHash: identity.source_bar_set_hash,
            rubricSlug: identity.source_rubric_slug,
            rubricRevision: Number(identity.source_rubric_revision),
            evidencePlane: identity.evidence_plane as SpecClauseBarPin['evidencePlane'],
          }
        : null;
    if (
      input.sourceBar === null &&
      priorBarPin &&
      input.specId.startsWith('AUTO-BAR-') &&
      normalized.lifecycleStatus !== 'superseded'
    ) {
      return { status: 'bar_pin_invalid', specId: input.specId, reason: 'bar_pin_unlink_forbidden' };
    }
    const effectiveBarPin: SpecClauseBarPin | null =
      input.sourceBar === undefined ? priorBarPin : (normalized.sourceBar ?? null);

    // WI-10003763: `acceptanceRef` is lineage as well. spec-quality requires it on every
    // contract-status revision, and AUTO-BAR projections record their BAR ref in it. So an
    // OMITTED ref rides the prior revision forward like `sourceBar`; only an explicit
    // `null` clears it. Writing NULL on omission did two silent things at once: it stripped
    // the ref spec-quality demands, and it made a lifecycle-only promotion hash as a real
    // edit, so the WI-10002889 proof carry below never fired and every binding went stale.
    // The hash is taken over the EFFECTIVE write, so the stored row and its hash agree.
    const priorAcceptanceRef = identity?.acceptance_ref ?? null;
    const effectiveInput: SpecClauseWrite =
      input.acceptanceRef === undefined && priorAcceptanceRef !== null
        ? { ...input, acceptanceRef: priorAcceptanceRef }
        : input;
    const writeHash = effectiveInput === input ? contentHash : specClauseContentHash(effectiveInput);
    const writeAcceptanceRef = canonicalWrite(effectiveInput).acceptanceRef;

    if (!identity && input.sourceValId) {
      const aliases = await tx<AliasIdentityRow[]>`
        SELECT plan_slug, spec_id
          FROM harness_shared.plan_spec_clauses
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND source_val_id = ${input.sourceValId}`;
      if (aliases[0]) {
        return {
          status: 'source_alias_conflict',
          specId: input.specId,
          sourceValId: input.sourceValId,
          conflictingPlanSlug: aliases[0].plan_slug,
          conflictingSpecId: aliases[0].spec_id,
        };
      }
    }

    // WI-10002889 (R-1) + WI-10003763: the prior revision this write differs from ONLY in
    // acceptance provenance (lifecycle and/or acceptanceRef), or null. The hash-equality return
    // below guarantees SOMETHING moved, so no separate "lifecycle changed" test is needed.
    let provenanceOnlyFrom: number | null = null;
    if (identity) {
      const current = await tx<{ content_hash: string; lifecycle_status: SpecLifecycleStatus | null }[]>`
        SELECT content_hash, lifecycle_status
          FROM harness_shared.plan_spec_clause_revisions
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND plan_slug = ${planSlug}
           AND spec_id = ${input.specId}
           AND revision = ${actualRevision}`;
      if (current[0]?.content_hash === writeHash) {
        return { status: 'unchanged', specId: input.specId, revision: actualRevision, contentHash: writeHash };
      }
      const priorLifecycle = current[0]?.lifecycle_status ?? null;
      if (
        current[0] &&
        priorLifecycle &&
        isEnforceableSpecLifecycle(normalized.lifecycleStatus) &&
        differsOnlyInAcceptanceProvenance(
          effectiveInput,
          { lifecycleStatus: priorLifecycle, acceptanceRef: priorAcceptanceRef },
          priorBarPin,
          current[0].content_hash,
        )
      ) {
        provenanceOnlyFrom = actualRevision;
      }
    } else {
      const inserted = await tx<{ spec_id: string }[]>`
        INSERT INTO harness_shared.plan_spec_clauses (
          workspace_id, harness_slug, plan_slug, spec_id, source_val_id,
          current_revision, created_by
        ) VALUES (
          ${scope.workspaceId}, ${scope.harnessSlug}, ${planSlug}, ${input.specId},
          ${input.sourceValId ?? null}, 0, ${input.actorId}
        )
        ON CONFLICT DO NOTHING
        RETURNING spec_id`;
      if (!inserted[0]) {
        const raced = await tx<IdentityRow[]>`
          SELECT source_val_id, current_revision
            FROM harness_shared.plan_spec_clauses
           WHERE workspace_id = ${scope.workspaceId}
             AND harness_slug = ${scope.harnessSlug}
             AND plan_slug = ${planSlug}
             AND spec_id = ${input.specId}`;
        if (raced[0]) {
          return {
            status: 'conflict',
            specId: input.specId,
            expectedRevision: input.expectedRevision,
            actualRevision: Number(raced[0].current_revision),
          };
        }
        const aliases = input.sourceValId
          ? await tx<AliasIdentityRow[]>`
              SELECT plan_slug, spec_id
                FROM harness_shared.plan_spec_clauses
               WHERE workspace_id = ${scope.workspaceId}
                 AND harness_slug = ${scope.harnessSlug}
                 AND source_val_id = ${input.sourceValId}`
          : [];
        if (input.sourceValId && aliases[0]) {
          return {
            status: 'source_alias_conflict',
            specId: input.specId,
            sourceValId: input.sourceValId,
            conflictingPlanSlug: aliases[0].plan_slug,
            conflictingSpecId: aliases[0].spec_id,
          };
        }
        throw new Error(`plan_spec_clause_identity_insert_failed:${planSlug}:${input.specId}`);
      }
    }

    const revision = actualRevision + 1;
    const accepted = normalized.lifecycleStatus === 'accepted' || normalized.lifecycleStatus === 'active';
    const exemptionJson = normalized.exemption === null ? null : JSON.stringify(canonicalJson(normalized.exemption));
    const falsifierJson = falsifier === null ? null : JSON.stringify(canonicalJson(falsifier));
    await tx`
      INSERT INTO harness_shared.plan_spec_clause_revisions (
        workspace_id, harness_slug, plan_slug, spec_id, revision, plan_item_id,
        behavior, behavior_class, required_evidence, required_test_layers,
        mutation_required, lifecycle_status, supersedes_spec_id, supersedes_revision,
        exemption, falsifier, content_hash, created_by, accepted_by, accepted_at, acceptance_ref,
        source_bar_key, source_bar_hash, source_bar_set_hash, source_rubric_slug,
        source_rubric_revision, evidence_plane
      ) VALUES (
        ${scope.workspaceId}, ${scope.harnessSlug}, ${planSlug}, ${input.specId}, ${revision},
        ${normalized.planItemId}, ${normalized.behavior}, ${normalized.behaviorClass},
        ${normalized.requiredEvidence}, ${normalized.requiredTestLayers}, ${normalized.mutationRequired},
        ${normalized.lifecycleStatus}, ${normalized.supersedes?.specId ?? null},
        ${normalized.supersedes?.revision ?? null}, ${exemptionJson}::text::jsonb,
        ${falsifierJson}::text::jsonb, ${writeHash},
        ${input.actorId}, ${accepted ? input.actorId : null}, ${accepted ? new Date() : null},
        ${writeAcceptanceRef}, ${effectiveBarPin?.barKey ?? null},
        ${effectiveBarPin?.barHash ?? null}, ${effectiveBarPin?.barSetHash ?? null},
        ${effectiveBarPin?.rubricSlug ?? null}, ${effectiveBarPin?.rubricRevision ?? null},
        ${effectiveBarPin?.evidencePlane ?? null}
      )`;

    await tx`
      UPDATE harness_shared.plan_spec_clauses
         SET current_revision = ${revision}, updated_at = now()
       WHERE workspace_id = ${scope.workspaceId}
         AND harness_slug = ${scope.harnessSlug}
         AND plan_slug = ${planSlug}
         AND spec_id = ${input.specId}`;

    // WI-10002889 (R-1) + WI-10003763: a provenance-only revision (the D-019 draft->active
    // promotion, or a restored acceptanceRef) keeps behavior, falsifier, layers and BAR pin
    // byte-identical, so the proof bound to the prior revision still proves this one. Re-attach
    // every work-item bound at the prior revision to this one (the carry joins through that edge,
    // and the FK demands it), then carry its live bindings. Without this, every promotion
    // stranded all proof and forced a full re-proof.
    let evidenceCarriedForward: number | undefined;
    if (provenanceOnlyFrom !== null) {
      await tx`
        INSERT INTO harness_shared.work_item_spec_revision_edges (
          workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
          spec_revision, spec_fingerprint, created_by
        )
        SELECT workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
               ${revision}, ${writeHash}, ${input.actorId}
          FROM harness_shared.work_item_spec_revision_edges
         WHERE workspace_id = ${scope.workspaceId}
           AND harness_slug = ${scope.harnessSlug}
           AND plan_slug = ${planSlug}
           AND spec_id = ${input.specId}
           AND spec_revision = ${provenanceOnlyFrom}
        ON CONFLICT DO NOTHING`;
      // Dynamic import: acceptance-bar-amendment imports this module (setSpecClause).
      const { carryUnchangedBarEvidenceBindings } = await import('../../acceptance-bar-amendment');
      evidenceCarriedForward = await carryUnchangedBarEvidenceBindings(tx as never, {
        workspaceId: scope.workspaceId,
        harnessSlug: scope.harnessSlug,
        planSlug,
        specId: input.specId,
        priorRevision: provenanceOnlyFrom,
        nextRevision: revision,
        nextSpecFingerprint: writeHash,
      });
    }

    const sourceValId = identity?.source_val_id ?? input.sourceValId ?? null;
    if (sourceValId) {
      await tx`
        INSERT INTO harness_shared.harness_plan_assertions (
          workspace_id, harness_slug, val_id, plan_slug, item_id,
          verify_text, evidence_text, status, requires_test
        ) VALUES (
          ${scope.workspaceId}, ${scope.harnessSlug}, ${sourceValId}, ${planSlug},
          ${normalized.planItemId}, ${normalized.behavior}, ${normalized.requiredEvidence.join('; ')},
          'todo', ${normalized.requiredTestLayers.length > 0}
        )
        ON CONFLICT (workspace_id, harness_slug, val_id) DO UPDATE SET
          plan_slug = EXCLUDED.plan_slug,
          item_id = EXCLUDED.item_id,
          verify_text = EXCLUDED.verify_text,
          evidence_text = EXCLUDED.evidence_text,
          requires_test = EXCLUDED.requires_test,
          updated_at = now()`;
    }

    return {
      status: actualRevision === 0 ? 'created' : 'revised',
      specId: input.specId,
      revision,
      contentHash: writeHash,
      ...(evidenceCarriedForward !== undefined ? { evidenceCarriedForward } : {}),
    };
  };
  return transaction
    ? write(transaction.executor)
    : withWorkspace(scope.workspaceId, async (tx) => write(tx as unknown as SpecClauseSql));
}

interface RevisionRow {
  plan_slug: string;
  spec_id: string;
  source_val_id: string | null;
  current_revision: number;
  revision: number;
  plan_item_id: string;
  behavior: string;
  behavior_class: SpecBehaviorClass;
  required_evidence: string[];
  required_test_layers: string[];
  mutation_required: boolean;
  lifecycle_status: SpecLifecycleStatus;
  supersedes_spec_id: string | null;
  supersedes_revision: number | null;
  exemption: Record<string, unknown> | null;
  falsifier: SpecClauseFalsifier | null;
  content_hash: string;
  created_by: string;
  created_at: Date | string;
  accepted_by: string | null;
  accepted_at: Date | string | null;
  acceptance_ref: string | null;
  source_bar_key: string | null;
  source_bar_hash: string | null;
  source_bar_set_hash: string | null;
  source_rubric_slug: string | null;
  source_rubric_revision: number | string | null;
  evidence_plane: 'tree' | 'deployed' | 'live' | null;
}

export interface ListSpecClausesOptions {
  harnessSlug?: string;
  planSlug: string;
  specIds?: string[];
  sourceValIds?: string[];
  planItemIds?: string[];
  revision?: number;
  includeHistory?: boolean;
  /** Optional SQL-side row cap. Filters are pushed down before the cap, so a
   * bounded snapshot cannot lose a requested current row behind history. */
  limit?: number;
}

/** Exact structured read; current-only unless includeHistory or revision is requested. */
export async function listSpecClauses(options: ListSpecClausesOptions): Promise<SpecClauseRevision[]> {
  const scope = await resolvePlanScope({ harnessSlug: options.harnessSlug });
  const specIds = options.specIds ?? [];
  const valIds = options.sourceValIds ?? [];
  const itemIds = options.planItemIds ?? [];
  const limit = options.limit == null ? null : Math.min(Math.max(Math.trunc(options.limit), 1), 5_000);
  const rows = await withWorkspace(
    scope.workspaceId,
    async (tx) => tx<RevisionRow[]>`
    SELECT c.plan_slug, c.spec_id, c.source_val_id, c.current_revision,
           r.revision, r.plan_item_id, r.behavior, r.behavior_class,
           r.required_evidence, r.required_test_layers, r.mutation_required,
           r.lifecycle_status, r.supersedes_spec_id, r.supersedes_revision,
           r.exemption, r.falsifier, r.content_hash, r.created_by, r.created_at,
           r.accepted_by, r.accepted_at, r.acceptance_ref,
           r.source_bar_key, r.source_bar_hash, r.source_bar_set_hash,
           r.source_rubric_slug, r.source_rubric_revision, r.evidence_plane
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r
        ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug
       AND r.plan_slug = c.plan_slug AND r.spec_id = c.spec_id
     WHERE c.workspace_id = ${scope.workspaceId}
       AND c.harness_slug = ${scope.harnessSlug}
       AND c.plan_slug = ${options.planSlug}
       AND (${specIds.length} = 0 OR c.spec_id = ANY(${specIds}::text[]))
       AND (${valIds.length} = 0 OR c.source_val_id = ANY(${valIds}::text[]))
       AND (${itemIds.length} = 0 OR r.plan_item_id = ANY(${itemIds}::text[]))
       AND ${
         options.revision !== undefined
           ? tx`r.revision = ${options.revision}`
           : options.includeHistory
             ? tx`TRUE`
             : tx`r.revision = c.current_revision`
       }
     ORDER BY c.spec_id, r.revision
     ${limit == null ? tx`` : tx`LIMIT ${limit}`}`,
  );

  const specIdSet = options.specIds ? new Set(options.specIds) : null;
  const valIdSet = options.sourceValIds ? new Set(options.sourceValIds) : null;
  const itemIdSet = options.planItemIds ? new Set(options.planItemIds) : null;
  return rows
    .filter((r) => !specIdSet || specIdSet.has(r.spec_id))
    .filter((r) => !valIdSet || (r.source_val_id !== null && valIdSet.has(r.source_val_id)))
    .filter((r) => !itemIdSet || itemIdSet.has(r.plan_item_id))
    .filter((r) =>
      options.revision !== undefined
        ? Number(r.revision) === options.revision
        : options.includeHistory || Number(r.revision) === Number(r.current_revision),
    )
    .map((r) => ({
      planSlug: r.plan_slug,
      specId: r.spec_id,
      sourceValId: r.source_val_id,
      currentRevision: Number(r.current_revision),
      revision: Number(r.revision),
      planItemId: r.plan_item_id,
      behavior: r.behavior,
      behaviorClass: r.behavior_class,
      requiredEvidence: r.required_evidence,
      requiredTestLayers: r.required_test_layers,
      mutationRequired: r.mutation_required,
      lifecycleStatus: r.lifecycle_status,
      supersedes:
        r.supersedes_spec_id && r.supersedes_revision
          ? { specId: r.supersedes_spec_id, revision: Number(r.supersedes_revision) }
          : null,
      exemption: r.exemption,
      falsifier: r.falsifier ?? null,
      contentHash: r.content_hash,
      createdBy: r.created_by,
      createdAt: pgTimestampToIso(r.created_at),
      acceptedBy: r.accepted_by,
      acceptedAt: pgTimestampToIsoOrNull(r.accepted_at),
      acceptanceRef: r.acceptance_ref,
      sourceBar:
        r.source_bar_key &&
        r.source_bar_hash &&
        r.source_bar_set_hash &&
        r.source_rubric_slug &&
        r.source_rubric_revision != null &&
        r.evidence_plane
          ? {
              barKey: r.source_bar_key,
              barHash: r.source_bar_hash,
              barSetHash: r.source_bar_set_hash,
              rubricSlug: r.source_rubric_slug,
              rubricRevision: Number(r.source_rubric_revision),
              evidencePlane: r.evidence_plane,
            }
          : null,
    }));
}
