/**
 * Mockup-to-implementation validation: the ratified-reference store.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-003).
 *
 * P-001 defined WHAT a ratified reference is (`ratification.ts`) and what
 * evidence about one looks like (`contract.ts`). This module makes a reference
 * DURABLE, on the design-artifact table that already exists — no new storage
 * system (D-003), and no new table: `harness_shared.harness_design_artifacts`
 * with `kind='ratified_reference'`, which migration 948 admitted.
 *
 * ─── THE THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE ──────────────────────
 *
 * 1. PROVENANCE IS IMMUTABLE. A stored record's `payload` is written once and
 *    never rewritten. Lifecycle — active, superseded, retracted — lives in
 *    `metadata`, which is a DERIVED PROJECTION of the payload plus that state.
 *    The reason is not tidiness: provenance is the audit trail that says which
 *    human ratified which bytes, and a field that can be edited in place cannot
 *    serve as one. `projectMetadata` is the only writer of that projection, and
 *    `reference-store.test.ts` asserts it round-trips, so the projection cannot
 *    drift from the payload it describes (the derived-truth rule).
 *
 * 2. REVISIONS ARE MONOTONIC, AND THE DATABASE ENFORCES IT. The artifact id is
 *    derived — `ratref:<referenceId>:<revision>` — so two agents racing to
 *    ratify revision 4 collide on the primary key. A read-then-write check
 *    alone cannot do that: both reads see revision 3, both decide 4 is next,
 *    and both write. `validateRatification` still runs, because a clear refusal
 *    beats a constraint violation, but the constraint is what makes the rule
 *    true under concurrency rather than merely usually true.
 *
 * 3. REVISING INVALIDATES PRIOR EVIDENCE, BY CONSTRUCTION. Evidence records the
 *    exact revision it was taken against; `isEvidenceCurrent` already refuses a
 *    mismatch. So a new revision does not need to go and mark old evidence
 *    stale — it is stale the moment the active revision moves, with no write
 *    and therefore no window in which a sweep has not run yet. `staleEvidence`
 *    reports which stored results just became unusable, for the human who wants
 *    to know what a revision cost them.
 *
 * The port is separated from the domain so the rules above are unit-testable
 * without a database, and so P-006 can expose them through the design-phase
 * plugin without importing Postgres. `reference-store-pg.ts` binds the port.
 */
import type { CaptureEnvironment, CompareResult, ReferenceClass } from './contract';
import {
  type RatificationError,
  type RatifiedReference,
  type ReferenceRetraction,
  superseded,
  validateRatification,
} from './ratification';

/** `harness_design_artifacts.kind` for a ratified reference (migration 948). */
export const RATIFIED_REFERENCE_ARTIFACT_KIND = 'ratified_reference';
/** `harness_design_artifacts.kind` for stored comparison evidence (migration 948). */
export const COMPARE_RESULT_ARTIFACT_KIND = 'compare_result';

/**
 * The image formats a caller may PRESENT. Not the formats that can be ratified —
 * see `COMPARABLE_MEDIA_TYPES`.
 */
export const REFERENCE_MEDIA_TYPES = ['image/png', 'image/jpeg'] as const;
export type ReferenceMediaType = (typeof REFERENCE_MEDIA_TYPES)[number];

/**
 * The formats the SELECTED comparison engine can actually read.
 *
 * P-005 is required to select pixelmatch (D-010 consequence 1), and lost-pixel's
 * pixelmatch path decodes both images with `PNG.sync.read` — read directly from
 * the installed `lost-pixel/dist/compare/compare.js:33-34`, which requires only
 * `pngjs`. pngjs decodes PNG and nothing else, so a JPEG reference cannot be
 * compared by the engine this system is required to use. (odiff does read JPEG,
 * which is exactly why this is worth stating: the capability exists in the
 * dependency tree and is unreachable through the engine we are mandated to
 * select.)
 *
 * So a JPEG reference is refused AT RATIFICATION rather than accepted and
 * discovered at comparison time. The failure is identical either way; the
 * difference is that here it is one clear refusal to the person uploading the
 * image, and there it is a gate that can never go green, found by whoever is
 * unlucky enough to be blocked by it.
 */
export const COMPARABLE_MEDIA_TYPES: readonly ReferenceMediaType[] = ['image/png'];

/**
 * Where a reference's bytes live.
 *
 * `sha256` is deliberately NOT here — it is `identity.contentSha256` on the
 * reference itself, because the digest is part of the reference's IDENTITY, not
 * of its storage. Duplicating it here would create two places to disagree.
 */
export interface ReferenceImageRef {
  readonly mediaType: ReferenceMediaType;
  /** Inline `data:` URL, an artifact URL, or a path — whatever the caller stored. */
  readonly locator: string;
  readonly byteLength: number;
  /** Dimensions as decoded at ratification. The contracted geometry of this reference. */
  readonly width: number;
  readonly height: number;
}

/** One durable ratified-reference record. `payload` in the artifact row. */
export interface StoredReference {
  readonly reference: RatifiedReference;
  readonly image: ReferenceImageRef;
  /** The accepted spec / feature this reference belongs to — the existing linkage. */
  readonly featureId: string;
  readonly harnessSlug: string;
}

/** A stored record as it comes back from the port, with its row identity. */
export interface StoredReferenceRow extends StoredReference {
  readonly artifactId: string;
  readonly createdTs: number;
}

/**
 * A reference to stored evidence. Only the fields staleness depends on: a store
 * that had to load whole `CompareResult`s to answer "what did this revision
 * invalidate" would read the entire evidence history to answer a question about
 * two integers.
 */
export interface StoredEvidenceRef {
  readonly artifactId: string;
  readonly referenceId: string;
  readonly referenceRevision: number;
  readonly capturedAt: string;
}

/** One durable comparison-evidence record: a whole normalized `CompareResult`. */
export interface StoredEvidence {
  readonly result: CompareResult;
  /** The accepted spec / feature this evidence belongs to — the existing linkage. */
  readonly featureId: string;
  readonly harnessSlug: string;
}

/** A stored evidence record as it comes back from the port, with its row identity. */
export interface StoredEvidenceRow extends StoredEvidence {
  readonly artifactId: string;
  readonly createdTs: number;
}

/**
 * A stable key for the environment a comparison was contracted at.
 *
 * Every field of `CaptureEnvironment` participates, in a fixed order, because
 * `environmentsMatch` treats every field as identity — a key that dropped one
 * would collapse two genuinely different renders onto the same evidence row.
 * `fixture`/`state` are optional on the type, so they are spelled as a literal
 * `-` when absent rather than left out: omitting them would let `{fixture:'a'}`
 * and `{state:'a'}` produce the same key.
 */
export function environmentCaseKey(env: CaptureEnvironment): string {
  return [
    `${env.viewport.width}x${env.viewport.height}`,
    `@${env.deviceScaleFactor}`,
    env.browser,
    env.theme,
    env.fontSet,
    env.fixture ?? '-',
    env.state ?? '-',
  ].join('|');
}

/**
 * The artifact id for one piece of evidence.
 *
 * Derived, not random, and that is a semantic choice rather than a storage one.
 * A comparison result is a FUNCTION of exactly these inputs: which reference
 * revision, which implementation revision, which target, at which contracted
 * environment. Two rows carrying the same inputs but different verdicts would
 * be a contradiction the gate cannot resolve — and whichever one it read would
 * be a coin flip that a caller could re-roll by re-running until it liked the
 * answer. Making the id deterministic means a re-run REPLACES its predecessor
 * (see `insertEvidence`) instead of accumulating a set to choose from.
 *
 * The cost is deliberate and bounded: re-run history is not kept here. Measuring
 * repeatability is P-008's job, with its own runs and its own records; it is not
 * something a gate should have to infer from duplicate evidence rows.
 */
export function evidenceArtifactId(result: CompareResult): string {
  return [
    'cmpres',
    result.reference.referenceId,
    String(result.reference.revision),
    result.target.targetId,
    result.target.implementationRevision,
    environmentCaseKey(result.environment),
  ].join(':');
}

/** The derived, queryable projection written to the artifact row's `metadata`. */
export interface ReferenceMetadataProjection {
  readonly referenceId: string;
  readonly revision: number;
  readonly referenceClass: ReferenceClass;
  readonly state: RatifiedReference['state'];
  readonly contentSha256: string;
  readonly mediaType: ReferenceMediaType;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly deviceScaleFactor: number;
  readonly browser: string;
  readonly theme: string;
  readonly fontSet: string;
  readonly fixture: string | null;
  /** The environment's interaction state ('default', 'hover', …), not the lifecycle state. */
  readonly interactionState: string | null;
  readonly requiredCaseCount: number;
  readonly supersededByRevision: number | null;
  /**
   * Retraction attribution, projected so "who lifted this obligation, and why"
   * is answerable by a QUERY. An audit trail reachable only by decoding every
   * payload is one nobody runs.
   */
  readonly retractedBy: string | null;
  readonly retractedReason: string | null;
  readonly retractedAt: string | null;
}

/**
 * Derive the queryable projection from a record.
 *
 * Everything here is already in the payload. It is projected out so a query can
 * filter by class, revision or viewport without parsing jsonb payloads — and it
 * is DERIVED in exactly one place so it can never say something the payload does
 * not. A hand-maintained metadata block would be a second copy of a truth the
 * payload owns, which is the drift this codebase has been bitten by repeatedly.
 */
export function projectMetadata(stored: StoredReference): ReferenceMetadataProjection {
  const env: CaptureEnvironment = stored.reference.referenceEnvironment;
  return {
    referenceId: stored.reference.identity.referenceId,
    revision: stored.reference.identity.revision,
    referenceClass: stored.reference.identity.referenceClass,
    state: stored.reference.state,
    contentSha256: stored.reference.identity.contentSha256,
    mediaType: stored.image.mediaType,
    width: stored.image.width,
    height: stored.image.height,
    viewportWidth: env.viewport.width,
    viewportHeight: env.viewport.height,
    deviceScaleFactor: env.deviceScaleFactor,
    browser: env.browser,
    theme: env.theme,
    fontSet: env.fontSet,
    fixture: env.fixture ?? null,
    interactionState: env.state ?? null,
    requiredCaseCount: stored.reference.requiredCases.length,
    supersededByRevision: stored.reference.supersededByRevision ?? null,
    retractedBy: stored.reference.retraction?.actor ?? null,
    retractedReason: stored.reference.retraction?.reason ?? null,
    retractedAt: stored.reference.retraction?.at ?? null,
  };
}

/**
 * The artifact id for a reference revision.
 *
 * Derived rather than random so the primary key `(harness_slug, id)` is what
 * enforces one-record-per-revision. See property 2 in the header.
 */
export function referenceArtifactId(referenceId: string, revision: number): string {
  return `ratref:${referenceId}:${revision}`;
}

// ─── the port ────────────────────────────────────────────────────────────────

export interface ReferenceScope {
  readonly harnessSlug: string;
  readonly featureId: string;
  readonly referenceId: string;
}

/** A feature-wide scope: every reference belonging to one accepted spec/feature. */
export interface FeatureScope {
  readonly harnessSlug: string;
  readonly featureId: string;
}

export interface ReferenceStorePort {
  /**
   * Every reference id ever ratified under one feature, ascending.
   *
   * Exists for the completion gate (P-007), and the reason it is DISCOVERY
   * rather than an argument is the whole security property: a gate that asks
   * the caller which references to check is bypassed by naming none. Under
   * D-019 a feature's viewports and states are separate references, so this is
   * also how the gate sees a feature's full obligation rather than one slice.
   *
   * Returns ids that have ever been ratified, including retracted and
   * superseded ones — applicability is decided per reference by the gate, not
   * filtered away here, so "ratified then retracted" stays distinguishable from
   * "never ratified".
   */
  listFeatureReferenceIds(scope: FeatureScope): Promise<readonly string[]>;
  /** Every revision of one reference, ascending. Empty when never ratified. */
  listRevisions(scope: ReferenceScope): Promise<readonly StoredReferenceRow[]>;
  /**
   * Insert a new revision. MUST reject a duplicate `artifactId` rather than
   * overwriting — that rejection is the concurrency guarantee, not a nicety.
   */
  insert(row: StoredReference & { readonly artifactId: string }): Promise<void>;
  /** Rewrite ONLY the lifecycle projection of an existing revision. */
  setLifecycle(
    scope: ReferenceScope,
    artifactId: string,
    lifecycle: {
      readonly state: RatifiedReference['state'];
      readonly supersededByRevision?: number;
      /** Required in practice for 'retracted'; `retractReference` is what enforces it. */
      readonly retraction?: ReferenceRetraction;
    },
  ): Promise<void>;
  /** Evidence rows bound to this reference, any revision. */
  listEvidence(scope: ReferenceScope): Promise<readonly StoredEvidenceRef[]>;
  /**
   * Write one comparison result, REPLACING any existing row with the same
   * derived id (see `evidenceArtifactId`). The replacement is the point: an
   * identical comparison re-run supersedes its own previous answer rather than
   * adding a second, equally-authoritative one beside it.
   *
   * Deliberately NOT the `insert` refusal-on-duplicate that references get.
   * A reference revision is a claim about what a human approved and a duplicate
   * is a lost update; a comparison result is a derived measurement and a
   * duplicate is just the same measurement taken again.
   */
  insertEvidence(row: StoredEvidence & { readonly artifactId: string }): Promise<void>;
  /**
   * Whole evidence records for this reference, any revision, oldest first.
   *
   * Separate from `listEvidence` on purpose: that one is the deliberately-thin
   * projection staleness needs, and answering "is this evidence current" must
   * not require decoding every stored `CompareResult`. This one is what a
   * reader wants, and it is only called when someone actually wants to read.
   */
  listEvidenceResults(scope: ReferenceScope): Promise<readonly StoredEvidenceRow[]>;
}

/** Thrown for a refusal a caller is expected to handle, not a bug. */
export class ReferenceStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'validation-failed'
      | 'revision-conflict'
      | 'not-ratified'
      | 'already-retracted'
      | 'unsupported-media-type',
    readonly errors: readonly RatificationError[] = [],
  ) {
    super(message);
    this.name = 'ReferenceStoreError';
  }
}

// ─── domain operations over the port ─────────────────────────────────────────

/**
 * The currently-active revision, or undefined.
 *
 * "Active" is a property of the record, not of being newest: a retracted
 * reference has a newest revision and no active one, and the surface is
 * unratified again (D-001). Anything that reads `rows[rows.length - 1]` as "the
 * current reference" quietly re-ratifies a withdrawn design.
 */
export function activeRevision(
  rows: readonly StoredReferenceRow[],
): StoredReferenceRow | undefined {
  return rows.filter((r) => r.reference.state === 'active').sort(
    (a, b) => b.reference.identity.revision - a.reference.identity.revision,
  )[0];
}

export function highestRevision(rows: readonly StoredReferenceRow[]): number {
  return rows.reduce((max, r) => Math.max(max, r.reference.identity.revision), 0);
}

export interface RatifyOutcome {
  readonly stored: StoredReferenceRow;
  /** The revision this one replaced, when it replaced one. */
  readonly supersededRevision?: number;
  /**
   * Evidence that this ratification just made unusable. Reported, never
   * rewritten: evidence is stale because the active revision moved, so there is
   * nothing to mark and no window in which the marking has not happened yet.
   */
  readonly invalidatedEvidence: readonly StoredEvidenceRef[];
}

export interface RatifyInput {
  readonly scope: ReferenceScope;
  readonly candidate: RatifiedReference;
  readonly image: ReferenceImageRef;
  readonly now: () => number;
}

/**
 * Ratify a reference, or a new revision of one.
 *
 * The candidate carries its own revision number rather than having one
 * allocated: a caller who read revision 3 and is submitting 4 is making a claim
 * about what it saw, and checking that claim is how a lost update is caught.
 * Allocating silently would turn a stale read into a successful write.
 */
export async function ratifyReference(
  port: ReferenceStorePort,
  input: RatifyInput,
): Promise<RatifyOutcome> {
  const { scope, candidate, image } = input;
  const rows = await port.listRevisions(scope);
  const previousActive = activeRevision(rows);

  // ORDER MATTERS. The revision check runs BEFORE shape validation, because the
  // two refusals ask the caller for different things: a conflict means "the
  // world moved under you — re-read and retry", while a validation failure means
  // "your submission is malformed — fix it and resubmit". Retrying a malformed
  // submission is pointless, and re-reading is pointless for a malformed one, so
  // handing back the wrong code sends the caller down the wrong path. Running
  // validation first would report a duplicate revision as a shape error, which
  // is precisely the case where a retry IS the right response.
  //
  // Monotonic against EVERY revision ever recorded, not just the active one.
  // `validateRatification` compares against the active revision, which is the
  // right check while one exists — but after a retraction there is no active
  // revision, and without this a caller could re-ratify a number that has been
  // used before. That is not merely untidy: evidence records the revision it
  // was taken against, so reusing a number would make old evidence read as
  // CURRENT for a different image. Reviving a retired revision number is the
  // one way to make stale evidence look fresh, so it is refused outright.
  const highest = highestRevision(rows);
  if (rows.length > 0 && candidate.identity.revision <= highest) {
    const collides = rows.some(
      (r) => r.reference.identity.revision === candidate.identity.revision,
    );
    throw new ReferenceStoreError(
      collides
        ? `revision ${candidate.identity.revision} of '${scope.referenceId}' already exists ` +
          `(the highest is ${highest}); re-read and submit the next revision`
        : `revision ${candidate.identity.revision} of '${scope.referenceId}' is below the ` +
          `highest ever recorded (${highest}); revision numbers are never reused, because ` +
          `evidence is bound to a number and reusing one would make stale evidence read as current`,
      'revision-conflict',
    );
  }

  if (!COMPARABLE_MEDIA_TYPES.includes(image.mediaType)) {
    throw new ReferenceStoreError(
      `'${image.mediaType}' cannot be ratified: the mandated comparison engine ` +
        `(lost-pixel's pixelmatch path) decodes both images with pngjs, which reads PNG only, ` +
        `so a ${image.mediaType} reference could be stored but never compared. ` +
        `Convert it to PNG before ratifying. Accepted: ${COMPARABLE_MEDIA_TYPES.join(', ')}.`,
      'unsupported-media-type',
    );
  }

  // Retraction is explicit, but re-ratifying the same identity must not erase
  // its adoption history and turn a required binding back into legacy metadata.
  const priorApproved = [...rows].reverse().find(row => row.reference.approval)?.reference;
  const errors = [...validateRatification(candidate, previousActive?.reference ?? priorApproved)];
  if (candidate.approval && candidate.approval.planSlug !== scope.featureId) {
    errors.push({ code: 'invalid-approval', message: 'approval planSlug must equal featureId so implementing items can discover the obligation without a supplied binding' });
  }
  if (errors.length > 0) {
    throw new ReferenceStoreError(
      `ratification refused: ${errors.map((e) => e.message).join('; ')}`,
      'validation-failed',
      errors,
    );
  }

  if (candidate.state !== 'active') {
    throw new ReferenceStoreError(
      `a reference is ratified into the 'active' state, not '${candidate.state}'; supersede or retract an existing revision instead`,
      'validation-failed',
    );
  }

  const artifactId = referenceArtifactId(scope.referenceId, candidate.identity.revision);
  const stored: StoredReference = {
    reference: candidate,
    image,
    featureId: scope.featureId,
    harnessSlug: scope.harnessSlug,
  };

  await port.insert({ ...stored, artifactId });

  let supersededRevision: number | undefined;
  if (previousActive) {
    const marked = superseded(previousActive.reference, candidate.identity.revision);
    await port.setLifecycle(scope, previousActive.artifactId, {
      state: marked.state,
      supersededByRevision: candidate.identity.revision,
    });
    supersededRevision = previousActive.reference.identity.revision;
  }

  const evidence = await port.listEvidence(scope);
  return {
    stored: { ...stored, artifactId, createdTs: input.now() },
    ...(supersededRevision !== undefined ? { supersededRevision } : {}),
    invalidatedEvidence: staleEvidence(candidate.identity.revision, evidence),
  };
}

/**
 * Retract the active revision. The surface becomes unratified (D-001): no
 * active revision means nothing to gate against, and every piece of evidence is
 * stale because there is no current revision for it to match.
 *
 * ─── WHY ATTRIBUTION IS A REQUIRED ARGUMENT ──────────────────────────────────
 *
 * This is the only call that turns a constrained surface back into an
 * unconstrained one — i.e. the only supported way to make a failing design gate
 * stop failing without producing the evidence it asked for. An OPTIONAL actor
 * and reason would be omitted exactly when they matter most, so they are
 * positional and validated here rather than defaulted: a caller that cannot say
 * who is retracting and why does not get to retract. The record is written as
 * part of the lifecycle transition itself, so a retracted revision cannot exist
 * in the store without it.
 */
export async function retractReference(
  port: ReferenceStorePort,
  scope: ReferenceScope,
  retraction: { readonly actor: string; readonly reason: string; readonly at: string },
): Promise<{
  readonly retractedRevision: number;
  readonly retraction: ReferenceRetraction;
  readonly invalidatedEvidence: readonly StoredEvidenceRef[];
}> {
  // Validated BEFORE the state is read, so a malformed retraction cannot leave a
  // half-applied transition behind it.
  const attribution = validRetraction(retraction);

  const rows = await port.listRevisions(scope);
  const active = activeRevision(rows);
  if (!active) {
    throw new ReferenceStoreError(
      rows.length === 0
        ? `'${scope.referenceId}' has never been ratified, so there is nothing to retract`
        : `'${scope.referenceId}' has no active revision (its newest is ${highestRevision(rows)}); it is already retracted or superseded`,
      rows.length === 0 ? 'not-ratified' : 'already-retracted',
    );
  }
  await port.setLifecycle(scope, active.artifactId, {
    state: 'retracted',
    retraction: attribution,
  });
  const evidence = await port.listEvidence(scope);
  return {
    retractedRevision: active.reference.identity.revision,
    retraction: attribution,
    // No active revision: EVERY piece of evidence is stale, including evidence
    // for the revision just retracted.
    invalidatedEvidence: evidence,
  };
}

/**
 * Reject a retraction that records nothing.
 *
 * Whitespace is trimmed and then required to be non-empty, because `' '` passes
 * a bare presence check while carrying exactly as much accountability as an
 * omitted field — and a bypass that satisfies the audit trail by typing a space
 * is the one this argument exists to prevent.
 */
function validRetraction(input: {
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}): ReferenceRetraction {
  const actor = input.actor?.trim() ?? '';
  const reason = input.reason?.trim() ?? '';
  const at = input.at?.trim() ?? '';
  const missing: string[] = [];
  if (!actor) missing.push('actor');
  if (!reason) missing.push('reason');
  if (!at) missing.push('at');
  if (missing.length > 0) {
    throw new ReferenceStoreError(
      `a retraction must record ${missing.join(' and ')}: retraction lifts a ratified obligation, ` +
        'so an unattributed one is indistinguishable from a silent bypass',
      'validation-failed',
    );
  }
  return { actor, reason, at };
}

/**
 * Which stored evidence is not current for `activeRevisionNumber`.
 *
 * `undefined` means there is no active revision — retracted, or never ratified —
 * in which case all evidence is stale. That case is spelled out rather than
 * defaulted, because "no active revision" defaulting to "nothing is stale" is
 * exactly backwards and would let a retracted design keep passing its gate.
 */
export function staleEvidence(
  activeRevisionNumber: number | undefined,
  evidence: readonly StoredEvidenceRef[],
): readonly StoredEvidenceRef[] {
  if (activeRevisionNumber === undefined) return evidence;
  return evidence.filter((e) => e.referenceRevision !== activeRevisionNumber);
}

// ─── an in-memory port ───────────────────────────────────────────────────────

/**
 * A complete in-memory port.
 *
 * Not only a test double: P-006 exposes these operations through the
 * design-phase plugin, and a plugin test that needs a working store but not a
 * database uses this. It enforces the SAME duplicate-id refusal the primary key
 * enforces, so a test cannot pass here and fail against Postgres.
 */
export function createInMemoryReferenceStore(): ReferenceStorePort & {
  readonly rows: Map<string, StoredReferenceRow>;
  /**
   * The evidence PROJECTION, which a staleness test can push into directly
   * without constructing a whole `CompareResult`. `insertEvidence` keeps this
   * in step with `evidenceRows` so the two can never disagree about which
   * evidence exists.
   */
  readonly evidence: StoredEvidenceRef[];
  readonly evidenceRows: Map<string, StoredEvidenceRow>;
} {
  const rows = new Map<string, StoredReferenceRow>();
  const evidence: StoredEvidenceRef[] = [];
  const evidenceRows = new Map<string, StoredEvidenceRow>();
  let clock = 0;

  const inScope = (row: StoredReferenceRow, scope: ReferenceScope): boolean =>
    row.harnessSlug === scope.harnessSlug &&
    row.featureId === scope.featureId &&
    row.reference.identity.referenceId === scope.referenceId;

  return {
    rows,
    evidence,
    evidenceRows,
    async listFeatureReferenceIds(scope) {
      const ids = new Set<string>();
      for (const r of rows.values()) {
        if (r.harnessSlug === scope.harnessSlug && r.featureId === scope.featureId) {
          ids.add(r.reference.identity.referenceId);
        }
      }
      return [...ids].sort();
    },
    async listRevisions(scope) {
      return [...rows.values()]
        .filter((r) => inScope(r, scope))
        .sort((a, b) => a.reference.identity.revision - b.reference.identity.revision);
    },
    async insert(row) {
      if (rows.has(row.artifactId)) {
        throw new ReferenceStoreError(
          `artifact '${row.artifactId}' already exists`,
          'revision-conflict',
        );
      }
      clock += 1;
      rows.set(row.artifactId, { ...row, createdTs: clock });
    },
    async setLifecycle(_scope, artifactId, lifecycle) {
      const row = rows.get(artifactId);
      if (!row) throw new ReferenceStoreError(`artifact '${artifactId}' not found`, 'not-ratified');
      rows.set(artifactId, {
        ...row,
        reference: {
          ...row.reference,
          state: lifecycle.state,
          ...(lifecycle.supersededByRevision !== undefined
            ? { supersededByRevision: lifecycle.supersededByRevision }
            : {}),
          ...(lifecycle.retraction !== undefined ? { retraction: lifecycle.retraction } : {}),
        },
      });
    },
    async listEvidence(scope) {
      return evidence.filter((e) => e.referenceId === scope.referenceId);
    },
    async insertEvidence(row) {
      clock += 1;
      const existing = evidenceRows.get(row.artifactId);
      evidenceRows.set(row.artifactId, {
        ...row,
        // Preserve the ORIGINAL creation stamp on a replacement. The row's
        // identity is the comparison, not this particular run of it, and a
        // re-run that reset the stamp would reorder history for no reason.
        createdTs: existing?.createdTs ?? clock,
      });
      const ref: StoredEvidenceRef = {
        artifactId: row.artifactId,
        referenceId: row.result.reference.referenceId,
        referenceRevision: row.result.reference.revision,
        capturedAt: row.result.capturedAt,
      };
      const at = evidence.findIndex((e) => e.artifactId === row.artifactId);
      if (at >= 0) evidence[at] = ref;
      else evidence.push(ref);
    },
    async listEvidenceResults(scope) {
      return [...evidenceRows.values()]
        .filter(
          (r) =>
            r.harnessSlug === scope.harnessSlug &&
            r.featureId === scope.featureId &&
            r.result.reference.referenceId === scope.referenceId,
        )
        .sort((a, b) => a.createdTs - b.createdTs);
    },
  };
}
