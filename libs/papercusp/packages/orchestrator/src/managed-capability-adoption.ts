/**
 * P-007 — the adoption report, teaching denials, and the version-drift check.
 *
 * Clause CAP-CONTRACT-P007-CUTOVER-EVIDENCE@1, verbatim: "The adoption report
 * shows a positive managed-path result and a negative native-bypass result for
 * every client capability enabled for cutover."
 *
 * ## Why this module exists at all
 *
 * D-012 established the discipline: before writing a test for a clause, check
 * that every NOUN in the clause can actually be RESOLVED from the data. Doing
 * that here:
 *
 *  - "every client capability enabled for cutover" RESOLVES. P-006 put
 *    `familyScope` on `AppliedCapabilityRestriction`, so a (client, family)
 *    pair is derivable from a resolved decision.
 *  - "a positive managed-path result" / "a negative native-bypass result" did
 *    NOT resolve. Nothing recorded either arm.
 *  - "The adoption report" did NOT resolve. It did not exist.
 *
 * So the missing mapping WAS the work, exactly as in D-012. This module is that
 * mapping; the policy gate in `managed-capability-policy.ts` then enforces it.
 *
 * ## The circularity, and how the report avoids being vacuous
 *
 * The policy gate WITHHOLDS a cutover whose pair lacks both arms. Read naively,
 * that makes this report trivially true: the only enabled pairs would be the
 * evidenced ones, so "every enabled pair has both arms" could never fail, and a
 * test of it would be the same unfalsifiable sentence D-012 was written about.
 *
 * The report therefore enumerates the pairs cutover is INTENDED for — what
 * readiness and the staging dial say should be enabled — rather than the pairs
 * the gate actually let through. It obtains that set by resolving the real
 * policy with a SATURATED adoption source, so only the parity, staging,
 * client, surface and audience gates decide; then it checks the intended set
 * against genuine telemetry. The two surfaces answer different questions and
 * neither is redundant:
 *
 *  - this report says "you staged X for cutover and cannot evidence it" — the
 *    actionable gap, and the falsifier's observation;
 *  - the gate says "so X is not applied" — the safe outcome.
 *
 * ## Vacuity is reported, never scored as a pass
 *
 * With no family `cutoverReady` on the shipped contract, the intended set is
 * EMPTY and "every enabled pair" is vacuously true. A report that returned
 * `satisfied` there would be the P-006 trap again, so the empty case is its own
 * verdict (`no-cutover-enabled`) and `pairsMeasured` / `contextsResolved` are
 * published for the same reason `capabilityRetentionCensus` publishes
 * `contextsMeasured`: a zero makes the measurement's own emptiness visible
 * instead of letting it read as a clean result.
 */

import {
  MANAGED_CAPABILITY_DISPOSITIONS,
  MANAGED_CAPABILITY_FAMILY_IDS,
  type ManagedCapabilityFamilyId,
} from './managed-capability-contract';
import {
  CAPABILITY_CLIENT_ENFORCEMENT,
  MANAGED_CAPABILITY_RESTRICTIONS,
  SHIPPED_CUTOVER_STAGING,
  resolveCapabilityPolicy,
  saturatedCapabilityMatrix,
  type CapabilityAdoptionEntry,
  type CapabilityAdoptionGateSource,
  type CapabilityAudience,
  type CapabilityClientFamily,
  type CapabilityCutoverStaging,
  type CapabilityPolicyDecision,
  type CapabilityPolicySurface,
  type CapabilityReadinessSource,
  type ManagedCapabilityRestriction,
} from './managed-capability-policy';

/** The two control arms the clause requires. Never one without the other. */
export type CapabilityControlArm = 'managed-path' | 'native-bypass';

/**
 * What an observation actually saw.
 *
 * Both arms carry a positive AND a negative outcome so the telemetry can record
 * a FAILED managed path and an ADMITTED bypass. A schema that could only
 * express successes would make the two most important findings — the adapter
 * does not work, the native route is still open — unrepresentable, and their
 * absence would be indistinguishable from never having looked.
 */
export type CapabilityArmOutcome =
  | 'managed-success'
  | 'managed-failure'
  | 'bypass-refused'
  | 'bypass-admitted';

const ARM_OUTCOMES: Readonly<Record<CapabilityControlArm, readonly CapabilityArmOutcome[]>> = {
  'managed-path': ['managed-success', 'managed-failure'],
  'native-bypass': ['bypass-refused', 'bypass-admitted'],
};

export interface CapabilityAdoptionObservation {
  readonly client: CapabilityClientFamily;
  readonly family: ManagedCapabilityFamilyId;
  readonly surface: CapabilityPolicySurface;
  readonly arm: CapabilityControlArm;
  readonly outcome: CapabilityArmOutcome;
  /** The client version this was measured on — what makes drift detectable. */
  readonly clientVersion: string;
  /** A ledger/test-run reference. Evidence that can be re-read, not a boolean. */
  readonly evidenceRef: string;
  readonly observedAt: string;
}

export type CapabilityAdoptionSource = readonly CapabilityAdoptionObservation[];

/**
 * One pair's verdict.
 *
 * Ordered by severity in `rowVerdict` below: an ADMITTED bypass outranks a
 * missing observation, because a demonstrated-open native route is a live
 * bypass of a restriction someone believes is enforced, while a missing
 * observation is merely unmeasured.
 */
export type CapabilityAdoptionVerdict =
  | 'accepted'
  | 'native-bypass-admitted'
  | 'managed-path-failing'
  | 'managed-path-missing'
  | 'native-bypass-missing'
  | 'acceptance-stale';

export interface CapabilityAdoptionRow {
  readonly client: CapabilityClientFamily;
  readonly family: ManagedCapabilityFamilyId;
  /** True when readiness + staging intend a cutover for this pair. */
  readonly cutoverEnabled: boolean;
  readonly enablingRestrictionIds: readonly string[];
  readonly verdict: CapabilityAdoptionVerdict;
  readonly managedPathEvidence: readonly string[];
  readonly nativeBypassEvidence: readonly string[];
  readonly observedVersions: readonly string[];
  readonly currentVersion: string | null;
  readonly detail: string;
}

/**
 * `no-cutover-enabled` is deliberately NOT `satisfied`. See the module header:
 * an empty quantification is a fact about the measurement, not a pass.
 */
export type CapabilityAdoptionClauseVerdict = 'satisfied' | 'violated' | 'no-cutover-enabled';

export interface CapabilityAdoptionReport {
  /** One row per (client, family), always total over both declared lists. */
  readonly rows: readonly CapabilityAdoptionRow[];
  readonly cutoverEnabled: readonly CapabilityAdoptionRow[];
  /** The falsifier's observation set: intended-enabled pairs lacking an arm. */
  readonly unevidenced: readonly CapabilityAdoptionRow[];
  readonly clauseVerdict: CapabilityAdoptionClauseVerdict;
  /** Observations whose outcome does not belong to their arm. */
  readonly malformedObservations: readonly string[];
  readonly pairsMeasured: number;
  readonly contextsResolved: number;
}

export interface CapabilityAdoptionReportOptions {
  readonly observations?: CapabilityAdoptionSource;
  readonly readiness?: CapabilityReadinessSource;
  readonly restrictions?: readonly ManagedCapabilityRestriction[];
  readonly cutoverStaging?: CapabilityCutoverStaging;
  readonly clients?: readonly CapabilityClientFamily[];
  readonly surfaces?: readonly CapabilityPolicySurface[];
  readonly audiences?: readonly CapabilityAudience[];
  readonly clientVersions?: Readonly<Partial<Record<CapabilityClientFamily, string>>>;
  readonly families?: readonly ManagedCapabilityFamilyId[];
}

const ALL_SURFACES: readonly CapabilityPolicySurface[] = ['launch', 'resume', 'wake'];
const ALL_AUDIENCES: readonly CapabilityAudience[] = ['headless-agent', 'interactive-su'];

function defaultClients(): readonly CapabilityClientFamily[] {
  // DERIVED from the enforcement map, never a second hand-kept client list, so
  // a client added there is measured here without touching this module.
  return Object.keys(CAPABILITY_CLIENT_ENFORCEMENT) as CapabilityClientFamily[];
}

/**
 * Every (client, family) pair proven on both arms.
 *
 * Used ONLY to discover which pairs readiness and staging INTEND to enable —
 * see the module header on circularity. Never passed to a real launch.
 */
function saturatedAdoption(
  clients: readonly CapabilityClientFamily[],
  families: readonly ManagedCapabilityFamilyId[],
): CapabilityAdoptionGateSource {
  const out: CapabilityAdoptionEntry[] = [];
  for (const client of clients) {
    for (const family of families) {
      out.push({ client, family, managedPathProven: true, nativeBypassRefused: true });
    }
  }
  return out;
}

/**
 * Collapse raw observations into the gate's minimal per-pair shape.
 *
 * The gate and the report read the SAME telemetry through this one function, so
 * they cannot disagree about what was observed. A pair is proven on an arm only
 * by that arm's POSITIVE outcome; a recorded failure/admission never counts as
 * evidence of acceptance.
 */
export function capabilityAdoptionGateSource(
  observations: CapabilityAdoptionSource,
): CapabilityAdoptionGateSource {
  const byPair = new Map<string, { entry: CapabilityAdoptionEntry; latestAt: string }>();
  for (const observation of observations) {
    if (!ARM_OUTCOMES[observation.arm]?.includes(observation.outcome)) continue;
    const key = `${observation.client}::${observation.family}`;
    const prior = byPair.get(key);
    // The version of the MOST RECENT observation for the pair. Drift is judged
    // against the freshest measurement, so a stale reading cannot mask a
    // current one, and re-measuring after a client upgrade clears the gate.
    const newer = prior === undefined || observation.observedAt > prior.latestAt;
    byPair.set(key, {
      latestAt: newer ? observation.observedAt : prior!.latestAt,
      entry: {
        client: observation.client,
        family: observation.family,
        managedPathProven:
          (prior?.entry.managedPathProven ?? false) || observation.outcome === 'managed-success',
        nativeBypassRefused:
          (prior?.entry.nativeBypassRefused ?? false) || observation.outcome === 'bypass-refused',
        atClientVersion: newer ? observation.clientVersion : prior!.entry.atClientVersion,
      },
    });
  }
  return [...byPair.values()].map((held) => held.entry);
}

function rowVerdict(
  arms: {
    managedSuccess: boolean;
    managedFailure: boolean;
    bypassRefused: boolean;
    bypassAdmitted: boolean;
  },
  stale: boolean,
): CapabilityAdoptionVerdict {
  if (arms.bypassAdmitted) return 'native-bypass-admitted';
  if (!arms.managedSuccess && arms.managedFailure) return 'managed-path-failing';
  if (!arms.managedSuccess) return 'managed-path-missing';
  if (!arms.bypassRefused) return 'native-bypass-missing';
  if (stale) return 'acceptance-stale';
  return 'accepted';
}

/**
 * The adoption report.
 *
 * Pure and total. Defaults to the shipped contract, policy table and staging;
 * every input is injectable so both sides of the clause are provable without a
 * real client — the same seam, and the same reason, as
 * `CapabilityPolicyRequest.readiness`.
 */
export function capabilityAdoptionReport(
  options: CapabilityAdoptionReportOptions = {},
): CapabilityAdoptionReport {
  const observations = options.observations ?? [];
  const restrictions = options.restrictions ?? MANAGED_CAPABILITY_RESTRICTIONS;
  const staging = options.cutoverStaging ?? SHIPPED_CUTOVER_STAGING;
  const clients = options.clients ?? defaultClients();
  const surfaces = options.surfaces ?? ALL_SURFACES;
  const audiences = options.audiences ?? ALL_AUDIENCES;
  // TOTAL over the DECLARED family list, never over the inventory: a family
  // declared and then forgotten by the inventory must still produce a row.
  const families = options.families ?? MANAGED_CAPABILITY_FAMILY_IDS;

  const malformedObservations: string[] = [];
  for (const observation of observations) {
    if (!ARM_OUTCOMES[observation.arm]?.includes(observation.outcome)) {
      malformedObservations.push(
        `${observation.client}/${observation.family}: outcome '${observation.outcome}' does not belong to arm '${observation.arm}' (${observation.evidenceRef}).`,
      );
    }
  }

  const saturated = saturatedAdoption(clients, families);
  const intended = new Map<string, Set<string>>();
  let contextsResolved = 0;
  for (const client of clients) {
    for (const surface of surfaces) {
      for (const audience of audiences) {
        contextsResolved += 1;
        const decision = resolveCapabilityPolicy(
          {
            client,
            surface,
            audience,
            readiness: options.readiness,
            adoption: saturated,
            // Hold the P-008 matrix dimension at "not the blocker" for the
            // same reason `adoption` is saturated one line above: this loop
            // enumerates cutover INTENT, and a downstream gate left at its
            // fail-safe default would withhold every restriction, making this
            // report see an empty population and answer
            // `no-cutover-enabled` — which would render THIS clause vacuous
            // rather than adding evidence to it.
            matrix: saturatedCapabilityMatrix(clients, families),
            cutoverStaging: staging,
          },
          restrictions,
        );
        for (const applied of decision.applied) {
          if (applied.authorityKind !== 'managed-cutover') continue;
          if (applied.familyScope.kind !== 'contract-family') continue;
          const key = `${client}::${applied.familyScope.family}`;
          const ids = intended.get(key) ?? new Set<string>();
          ids.add(applied.id);
          intended.set(key, ids);
        }
      }
    }
  }

  const rows: CapabilityAdoptionRow[] = [];
  for (const client of clients) {
    const currentVersion = options.clientVersions?.[client] ?? null;
    for (const family of families) {
      const key = `${client}::${family}`;
      const pairObservations = observations.filter(
        (observation) =>
          observation.client === client &&
          observation.family === family &&
          ARM_OUTCOMES[observation.arm]?.includes(observation.outcome),
      );
      const arms = {
        managedSuccess: pairObservations.some((o) => o.outcome === 'managed-success'),
        managedFailure: pairObservations.some((o) => o.outcome === 'managed-failure'),
        bypassRefused: pairObservations.some((o) => o.outcome === 'bypass-refused'),
        bypassAdmitted: pairObservations.some((o) => o.outcome === 'bypass-admitted'),
      };
      const observedVersions = [...new Set(pairObservations.map((o) => o.clientVersion))].sort();
      const stale =
        currentVersion !== null &&
        observedVersions.length > 0 &&
        !observedVersions.includes(currentVersion);
      const verdict = rowVerdict(arms, stale);
      const enablingRestrictionIds = [...(intended.get(key) ?? new Set<string>())].sort();
      rows.push({
        client,
        family,
        cutoverEnabled: enablingRestrictionIds.length > 0,
        enablingRestrictionIds,
        verdict,
        managedPathEvidence: pairObservations
          .filter((o) => o.outcome === 'managed-success')
          .map((o) => o.evidenceRef),
        nativeBypassEvidence: pairObservations
          .filter((o) => o.outcome === 'bypass-refused')
          .map((o) => o.evidenceRef),
        observedVersions,
        currentVersion,
        detail: describeRow(client, family, verdict, observedVersions, currentVersion),
      });
    }
  }

  const cutoverEnabled = rows.filter((row) => row.cutoverEnabled);
  const unevidenced = cutoverEnabled.filter((row) => row.verdict !== 'accepted');
  const clauseVerdict: CapabilityAdoptionClauseVerdict =
    cutoverEnabled.length === 0 ? 'no-cutover-enabled' : unevidenced.length ? 'violated' : 'satisfied';

  return {
    rows,
    cutoverEnabled,
    unevidenced,
    clauseVerdict,
    malformedObservations,
    pairsMeasured: rows.length,
    contextsResolved,
  };
}

function describeRow(
  client: CapabilityClientFamily,
  family: ManagedCapabilityFamilyId,
  verdict: CapabilityAdoptionVerdict,
  observedVersions: readonly string[],
  currentVersion: string | null,
): string {
  const pair = `'${family}' at ${client}`;
  switch (verdict) {
    case 'accepted':
      return `${pair} has a successful managed-path observation and a refused native-bypass observation.`;
    case 'native-bypass-admitted':
      return `${pair} recorded an ADMITTED native bypass — the native route is still open, so the restriction does not restrict.`;
    case 'managed-path-failing':
      return `${pair} recorded a FAILING managed path; the replacement does not work here.`;
    case 'managed-path-missing':
      return `${pair} has no successful managed-path observation.`;
    case 'native-bypass-missing':
      return `${pair} has no refused native-bypass observation, so nothing shows the native route is shut.`;
    case 'acceptance-stale':
      return `${pair} was accepted on version(s) ${observedVersions.join(', ')} but the client is now on '${currentVersion ?? 'unknown'}'.`;
  }
}

/* ------------------------------------------------------------------ *
 * Teaching denials
 * ------------------------------------------------------------------ */

/**
 * What a denied native name should TELL the caller.
 *
 * DERIVED from the decision plus the contract, never stored on the decision:
 * `familyScope` is already carried on `AppliedCapabilityRestriction` (P-006)
 * and `managedAuthorities` already lives on the disposition, so restating
 * either here would be the duplication the derived-truth ladder forbids.
 */
export interface CapabilityDenialTeaching {
  readonly nativeName: string;
  readonly restrictionId: string;
  readonly family: ManagedCapabilityFamilyId | null;
  readonly outsideTaxonomyNote: string | null;
  readonly managedAlternatives: readonly string[];
  /** True when the denial names no replacement — a stranding denial. */
  readonly strands: boolean;
  readonly message: string;
}

function managedAuthoritiesFor(family: ManagedCapabilityFamilyId): readonly string[] {
  return (
    MANAGED_CAPABILITY_DISPOSITIONS.find((entry) => entry.family === family)?.managedAuthorities ??
    []
  );
}

/**
 * The teaching record for every name this decision denies.
 *
 * A denial with no managed alternative is reported as `strands: true` and says
 * so in its own message. Rendering a cheerful "use one of: " with an empty list
 * is the failure mode this flag exists to prevent — the honest truth is that
 * the capability is gone with nothing in its place.
 */
export function capabilityDecisionTeaching(
  decision: CapabilityPolicyDecision,
): readonly CapabilityDenialTeaching[] {
  const out: CapabilityDenialTeaching[] = [];
  for (const applied of decision.applied) {
    const family =
      applied.familyScope.kind === 'contract-family' ? applied.familyScope.family : null;
    const outsideTaxonomyNote =
      applied.familyScope.kind === 'outside-r1-taxonomy' ? applied.familyScope.note : null;
    const managedAlternatives = family ? managedAuthoritiesFor(family) : [];
    const strands = managedAlternatives.length === 0;
    for (const nativeName of applied.deniedNames) {
      out.push({
        nativeName,
        restrictionId: applied.id,
        family,
        outsideTaxonomyNote,
        managedAlternatives,
        strands,
        message: strands
          ? `'${nativeName}' is denied by ${applied.id}. ` +
            (family
              ? `No managed authority is inventoried for '${family}', so this denial names no replacement — treat the capability as unsupported rather than moved.`
              : `It is scoped outside the R-1 family taxonomy (${outsideTaxonomyNote ?? 'no note'}), so no managed replacement is inventoried for it.`)
          : `'${nativeName}' is denied by ${applied.id}. Use ${managedAlternatives
              .map((name) => `'${name}'`)
              .join(' or ')} instead — the managed authority for '${family}'.`,
      });
    }
  }
  return out;
}

/** The teaching record for ONE denied name, or null when it is not denied. */
export function capabilityDenialTeaching(
  decision: CapabilityPolicyDecision,
  nativeName: string,
): CapabilityDenialTeaching | null {
  return (
    capabilityDecisionTeaching(decision).find((entry) => entry.nativeName === nativeName) ?? null
  );
}
