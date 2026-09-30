/**
 * The isolated real-client acceptance matrix (P-008,
 * CAP-CONTRACT-P008-REAL-CLIENT-MATRIX@1).
 *
 * THE CLAUSE: "The isolated real-client matrix passes every declared launch,
 * resume, wake, recovery, lifecycle, sandbox, and native-disable scenario
 * before a managed default is enabled."
 *
 * ITS FALSIFIER: "A managed default is enabled while any declared real-client
 * scenario is missing, failing, stale, or run against a different client
 * version." Those FOUR words are the whole contract, so they are the four
 * non-passing states `RealClientScenarioStatus` can take — no more, no fewer.
 * A fifth state would be a claim the clause does not make; a missing one would
 * be a hole the gate cannot see.
 *
 * WHY THIS MODULE EXISTS AT ALL. P-007 left the enabling act deliberately
 * unevidenced: `SHIPPED_CUTOVER_STAGING` is `{}` (every family `off`) and its
 * comment says, verbatim, "Enabling is a separate, stated act (P-008 supplies
 * the measured evidence; this dial admits it in stages)." This module is that
 * evidence plane. Before it, the sentence "the matrix passes every declared
 * scenario" named nothing that resolved from data — there was no manifest, no
 * scenario taxonomy, no result fingerprint and no enablement record anywhere
 * in the tree, so the clause was unfalsifiable in exactly the way D-012
 * diagnosed for P-006. Per D-012 the missing mapping IS the work.
 *
 * DERIVED, NOT HAND-AUTHORED (derived-truth ladder, rung 1). The scenario
 * manifest is computed from the restriction registry: the families come from
 * `familyScope`, the clients from `restriction.clients`, and the three
 * surface-bound scenario kinds are declared only for surfaces the restriction
 * actually covers. A hand-written scenario list would be a second copy of the
 * policy table and would drift from it silently — which is the precise defect
 * D-012 found in `MANAGED_CAPABILITY_RESTRICTIONS` itself.
 *
 * DEPENDENCY DIRECTION. This module imports the policy; the policy never
 * imports this module. The policy declares the minimal shape it needs
 * (`CapabilityMatrixEntry`) exactly as it already does for readiness and
 * adoption, so the gate can be driven from both sides in a test without a real
 * client, and the import graph stays acyclic.
 */

import { createHash } from 'node:crypto';

import { type ManagedCapabilityFamilyId } from './managed-capability-contract';
import {
  MANAGED_CAPABILITY_RESTRICTIONS,
  type CapabilityClientFamily,
  type CapabilityMatrixEntry,
  type CapabilityMatrixGateSource,
  type CapabilityPolicySurface,
  type ManagedCapabilityRestriction,
} from './managed-capability-policy';

/**
 * The scenario kinds the clause enumerates, in its own order.
 *
 * This tuple is the clause text transcribed once. Every other scenario fact in
 * this module is derived, so if the clause is amended this is the single place
 * the taxonomy changes.
 */
export const REAL_CLIENT_SCENARIO_KINDS = [
  'launch',
  'resume',
  'wake',
  'recovery',
  'lifecycle',
  'sandbox',
  'native-disable',
] as const;

export type RealClientScenarioKind = (typeof REAL_CLIENT_SCENARIO_KINDS)[number];

/**
 * The three scenario kinds that ARE a policy surface.
 *
 * `launch`, `resume` and `wake` are the exact members of
 * `CapabilityPolicySurface`, which is why a scenario of one of these kinds is
 * declared only when the restriction covers that surface: claiming a
 * `resume` scenario for a launch-only restriction would manufacture a
 * permanently-missing scenario and wedge the gate closed forever. The other
 * four kinds are cross-surface properties of the managed replacement, so they
 * are declared for every covered family/client pair.
 */
const SURFACE_BOUND_SCENARIO_KINDS: Readonly<
  Partial<Record<RealClientScenarioKind, CapabilityPolicySurface>>
> = Object.freeze({
  launch: 'launch',
  resume: 'resume',
  wake: 'wake',
});

/** One declared cell of the matrix. */
export interface RealClientScenario {
  /** `<family>:<client>:<kind>` — stable, and deduped across restrictions. */
  readonly id: string;
  readonly family: ManagedCapabilityFamilyId;
  readonly client: CapabilityClientFamily;
  readonly kind: RealClientScenarioKind;
  /** The surface a surface-bound scenario exercises; absent for the rest. */
  readonly surface?: CapabilityPolicySurface;
  /** The restriction ids that caused this cell to be declared. */
  readonly declaredBy: readonly string[];
}

/**
 * Derive the declared matrix from the restriction registry.
 *
 * Only `managed-cutover` restrictions scoped to a contract family can declare
 * scenarios: an owner mandate has no managed replacement to accept, and a
 * restriction scoped outside the family taxonomy has no disposition to trace
 * (the same two exclusions `resolveCapabilityPolicy` already applies before it
 * consults readiness, so the manifest covers exactly the population the gate
 * can act on).
 */
export function declareRealClientMatrix(
  restrictions: readonly ManagedCapabilityRestriction[] = MANAGED_CAPABILITY_RESTRICTIONS,
): readonly RealClientScenario[] {
  const byId = new Map<string, { scenario: RealClientScenario; declaredBy: string[] }>();

  for (const restriction of restrictions) {
    if (restriction.authority.kind !== 'managed-cutover') continue;
    if (restriction.familyScope.kind !== 'contract-family') continue;
    const family = restriction.familyScope.family;

    for (const client of restriction.clients) {
      for (const kind of REAL_CLIENT_SCENARIO_KINDS) {
        const surface = SURFACE_BOUND_SCENARIO_KINDS[kind];
        if (surface !== undefined && !restriction.surfaces.includes(surface)) continue;

        const id = `${family}:${client}:${kind}`;
        const existing = byId.get(id);
        if (existing) {
          if (!existing.declaredBy.includes(restriction.id)) existing.declaredBy.push(restriction.id);
          continue;
        }
        const declaredBy = [restriction.id];
        byId.set(id, {
          declaredBy,
          scenario: { id, family, client, kind, ...(surface ? { surface } : {}), declaredBy },
        });
      }
    }
  }

  return [...byId.values()]
    .map(({ scenario }) => scenario)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** What one execution of one scenario, in an isolated client profile, saw. */
export interface RealClientScenarioResult {
  readonly scenarioId: string;
  readonly outcome: 'pass' | 'fail';
  /** The client version the isolated profile actually ran. */
  readonly clientVersion: string;
  /** ISO-8601. Staleness is measured from here, never from a file mtime. */
  readonly observedAt: string;
  /**
   * The fingerprint the executor published for this result. Deliberately NOT
   * trusted: the report recomputes the canonical fingerprint from the result's
   * own fields and reports a disagreement as an integrity issue, because a
   * result that misreports its own fingerprint would otherwise satisfy a
   * record comparison it never actually matched.
   */
  readonly fingerprint?: string;
}

/**
 * The canonical fingerprint of a result.
 *
 * Deterministic and derived only from the three facts that decide whether the
 * result is evidence for a given enablement: WHICH scenario, on WHICH client
 * version, with WHICH outcome. Time is excluded on purpose — re-observing the
 * same pass on the same version must not invalidate an enablement, or the
 * record would need re-pinning on every run and the comparison would become
 * noise instead of a control.
 *
 * The separator is a NUL escape (never a raw byte, which would make the file
 * unsearchable by ripgrep and binary to git diff) because it is the one byte
 * that cannot occur in a scenario id or a version string, which is what makes
 * the concatenation injective.
 */
export function scenarioResultFingerprint(
  result: Pick<RealClientScenarioResult, 'scenarioId' | 'clientVersion' | 'outcome'>,
): string {
  return createHash('sha256')
    .update(`${result.scenarioId}\x00${result.clientVersion}\x00${result.outcome}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * What a managed default was enabled AGAINST.
 *
 * This is the "default-enablement record" the falsifier's probe method names.
 * It pins the exact fingerprints that justified the enablement, so a later
 * re-run on a different client version (or a quietly re-declared scenario)
 * cannot inherit the old decision: the pinned fingerprint and the current one
 * stop agreeing, and the gate says so.
 */
export interface CapabilityDefaultEnablementRecord {
  readonly family: ManagedCapabilityFamilyId;
  readonly client: CapabilityClientFamily;
  /** ISO-8601 — when the managed default was enabled. */
  readonly enabledAt: string;
  /** scenarioId -> the fingerprint the enablement was justified by. */
  readonly scenarioFingerprints: Readonly<Record<string, string>>;
}

/**
 * The status of one declared scenario.
 *
 * The four non-passing members are the four words of the falsifier, and
 * nothing else. See the module header.
 */
export type RealClientScenarioStatus =
  | 'passed'
  | 'missing'
  | 'failing'
  | 'stale'
  | 'version-mismatch';

export interface RealClientScenarioRow {
  readonly scenario: RealClientScenario;
  readonly status: RealClientScenarioStatus;
  /** The result this row was decided from, when one existed at all. */
  readonly result?: RealClientScenarioResult;
  /** Canonical fingerprint of `result`, when there is a result. */
  readonly fingerprint?: string;
  /**
   * True when a default-enablement record exists for this family/client and
   * its pinned fingerprint for this scenario does not equal `fingerprint`.
   * Tracked SEPARATELY from `status` because drift is what the probe method
   * detects, not a fifth way for a scenario to be unproven.
   */
  readonly enablementDrift: boolean;
  readonly detail: string;
}

export interface RealClientMatrixReportOptions {
  readonly scenarios?: readonly RealClientScenario[];
  readonly results?: readonly RealClientScenarioResult[];
  readonly records?: readonly CapabilityDefaultEnablementRecord[];
  /** Current version per client; an unknown version cannot prove a mismatch. */
  readonly clientVersions?: Readonly<Partial<Record<CapabilityClientFamily, string>>>;
  readonly now?: Date;
  /** How long a result stays evidence. Defaults to {@link DEFAULT_SCENARIO_FRESHNESS_MS}. */
  readonly freshnessWindowMs?: number;
}

/**
 * Seven days.
 *
 * Long enough that an ordinary week of no client releases does not expire a
 * whole matrix, short enough that a silently-abandoned acceptance run stops
 * counting as evidence well before a client ships a new minor. It is a
 * declared window rather than a derived one because nothing in the tree
 * measures client release cadence; when something does, derive it.
 */
export const DEFAULT_SCENARIO_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export interface RealClientMatrixReport {
  readonly rows: readonly RealClientScenarioRow[];
  /** Per family/client, in the minimal shape the policy gate consumes. */
  readonly entries: CapabilityMatrixGateSource;
  /** Results whose published fingerprint contradicts their own fields. */
  readonly integrityIssues: readonly string[];
  readonly declaredCount: number;
  readonly passedCount: number;
  /** True only when every declared scenario passed and nothing drifted. */
  readonly allDeclaredScenariosPassed: boolean;
}

/**
 * Resolve the manifest against observed results and the enablement records.
 *
 * Status precedence is deliberate: `missing` (nothing ran) beats `failing`
 * (it ran and said no) beats `version-mismatch` (it passed, but not on the
 * version this launch is) beats `stale` (it passed on the right version, too
 * long ago). Version-mismatch outranks staleness because a FRESH run on the
 * wrong version is still not evidence about this version, whereas staleness is
 * a statement about age on the RIGHT version — reporting the weaker label
 * first would send a reader to re-run a matrix when they actually need to
 * re-pin a version.
 */
export function realClientMatrixReport(
  options: RealClientMatrixReportOptions = {},
): RealClientMatrixReport {
  const scenarios = options.scenarios ?? declareRealClientMatrix();
  const results = options.results ?? [];
  const records = options.records ?? [];
  const now = options.now ?? new Date();
  const freshnessWindowMs = options.freshnessWindowMs ?? DEFAULT_SCENARIO_FRESHNESS_MS;

  const integrityIssues: string[] = [];

  // Latest result per scenario, so a re-run supersedes rather than accumulates.
  const latest = new Map<string, RealClientScenarioResult>();
  for (const result of results) {
    const canonical = scenarioResultFingerprint(result);
    if (result.fingerprint !== undefined && result.fingerprint !== canonical) {
      integrityIssues.push(
        `${result.scenarioId}: published fingerprint '${result.fingerprint}' does not describe its own ` +
          `result (outcome '${result.outcome}' on version '${result.clientVersion}' fingerprints as '${canonical}').`,
      );
    }
    const prior = latest.get(result.scenarioId);
    if (!prior || Date.parse(result.observedAt) >= Date.parse(prior.observedAt)) {
      latest.set(result.scenarioId, result);
    }
  }

  const recordFor = (family: ManagedCapabilityFamilyId, client: CapabilityClientFamily) =>
    records.find((entry) => entry.family === family && entry.client === client);

  const rows: RealClientScenarioRow[] = scenarios.map((scenario) => {
    const result = latest.get(scenario.id);
    const record = recordFor(scenario.family, scenario.client);

    if (!result) {
      return {
        scenario,
        status: 'missing',
        enablementDrift: record !== undefined,
        detail:
          `No isolated real-client result exists for '${scenario.id}' ` +
          `(${scenario.kind}${scenario.surface ? ` on the ${scenario.surface} surface` : ''}).`,
      };
    }

    const fingerprint = scenarioResultFingerprint(result);
    const pinned = record?.scenarioFingerprints[scenario.id];
    const enablementDrift = record !== undefined && pinned !== fingerprint;
    const driftNote = enablementDrift
      ? ` The enabled default was justified by ${pinned ? `fingerprint '${pinned}'` : 'no fingerprint for this scenario'}, not '${fingerprint}'.`
      : '';

    const base = { scenario, result, fingerprint, enablementDrift } as const;

    if (result.outcome === 'fail') {
      return {
        ...base,
        status: 'failing',
        detail: `'${scenario.id}' FAILED on client version '${result.clientVersion}'.${driftNote}`,
      };
    }

    const current = options.clientVersions?.[scenario.client];
    if (current !== undefined && current !== result.clientVersion) {
      return {
        ...base,
        status: 'version-mismatch',
        detail:
          `'${scenario.id}' passed on client version '${result.clientVersion}', but this client is ` +
          `'${current}'. A version change can respell the native surface, so the result is not ` +
          `evidence for this version.${driftNote}`,
      };
    }

    const ageMs = now.getTime() - Date.parse(result.observedAt);
    if (Number.isFinite(ageMs) && ageMs > freshnessWindowMs) {
      return {
        ...base,
        status: 'stale',
        detail:
          `'${scenario.id}' last passed at ${result.observedAt}, which is older than the ` +
          `${Math.round(freshnessWindowMs / 3_600_000)}h freshness window.${driftNote}`,
      };
    }

    return {
      ...base,
      status: 'passed',
      detail: enablementDrift
        ? `'${scenario.id}' passes, but its fingerprint no longer matches the enablement record.${driftNote}`
        : `'${scenario.id}' passed on client version '${result.clientVersion}' at ${result.observedAt}.`,
    };
  });

  // Collapse to one entry per family/client — the unit the policy gate asks
  // about, since a restriction is enabled for a family AT a client.
  const entryKeys = new Map<
    string,
    { family: ManagedCapabilityFamilyId; client: CapabilityClientFamily }
  >();
  for (const scenario of scenarios) {
    entryKeys.set(`${scenario.family}::${scenario.client}`, {
      family: scenario.family,
      client: scenario.client,
    });
  }

  const entries: CapabilityMatrixEntry[] = [...entryKeys.values()].map(({ family, client }) => {
    const owned = rows.filter(
      (row) => row.scenario.family === family && row.scenario.client === client,
    );
    const unmet = owned
      .filter((row) => row.status !== 'passed' || row.enablementDrift)
      .map((row) => ({
        scenarioId: row.scenario.id,
        status: row.enablementDrift && row.status === 'passed' ? 'enablement-drift' : row.status,
        detail: row.detail,
      }));
    return {
      client,
      family,
      allScenariosPassed: owned.length > 0 && unmet.length === 0,
      declaredScenarioCount: owned.length,
      unmet,
    };
  });

  const passedCount = rows.filter((row) => row.status === 'passed' && !row.enablementDrift).length;

  return {
    rows,
    entries,
    integrityIssues,
    declaredCount: rows.length,
    passedCount,
    allDeclaredScenariosPassed: rows.length > 0 && passedCount === rows.length,
  };
}

/** The gate source, for handing straight to `resolveCapabilityPolicy`. */
export function realClientMatrixGateSource(
  options: RealClientMatrixReportOptions = {},
): CapabilityMatrixGateSource {
  return realClientMatrixReport(options).entries;
}
