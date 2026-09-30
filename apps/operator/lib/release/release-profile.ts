/**
 * release-profile.ts — the papercusp WIRING for the generic composite release-profile
 * evaluator (`@papercusp/release-profile`; rubric-system-and-auto-loop-release-profile-
 * 2026-07-15 P-006).
 *
 * The generic lib knows nothing about rubrics, scorecards, or git — it only combines
 * `ComponentSpec.check()` results into one GO/NO-GO, applying staleness + lineage
 * policy uniformly. This module supplies the two concrete component KINDS the plan
 * calls for:
 *
 *   - a RUBRIC component — the latest COMPLETE scorecard for an ACTIVE, releaseGating
 *     rubric, reduced to a worst-case pass/fail/unknown verdict (reuses the existing
 *     `rubrics`/`scorecards` read paths — no new rubric machinery);
 *   - a hard OPERATIONAL GATE component — deploy-pin staleness, reusing the already-
 *     written (but previously unwired) `evaluateDeployStaleness` pure decision + the
 *     `git-ops` primitives this package already ships.
 *
 * `buildPapercuspReleaseProfile` assembles every ACTIVE `releaseGating` rubric plus the
 * deploy-staleness gate into one `ReleaseProfileSpec`, stamped with the RUNNING
 * generation as `expectedLineage` (EI-12147's sha/hostStartedAt identity) so a
 * scorecard graded against a stale/different generation is refused as
 * 'lineage-mismatch', not silently accepted. `evaluatePapercuspReleaseProfile` runs it
 * through the generic evaluator. This is the CORE artifact WI-3548's GO/NO-GO synthesis
 * consumes — P-007/P-008 add the missing component rubrics and the strict live gates
 * this composes; this module's job is the reusable schema/evaluator + a REAL, proven
 * wiring of at least one of each component kind.
 */
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  evaluateReleaseProfile,
  type ComponentCheckResult,
  type ComponentRawVerdict,
  type ComponentSpec,
  type EvaluateReleaseProfileOpts,
  type ReleaseProfileSpec,
  type ReleaseProfileVerdict,
} from '@papercusp/release-profile';
import { getRubric as defaultGetRubric, listRubrics as defaultListRubrics } from '@papercusp/operator-core/lib/rubrics';
import {
  evaluateScorecardInstrumentContract,
  listScorecards as defaultListScorecards,
  type ScorecardInstrumentContractEvaluation,
  type ScorecardRow,
} from '@papercusp/operator-core/lib/scorecards';
import {
  readRunningGeneration as defaultReadRunningGeneration,
  readBgHostActiveEnterMs as defaultReadBgHostActiveEnterMs,
  compareGenerationFreshness,
} from '@papercusp/operator-core/lib/scout/generation-watermark';
import { currentSha as defaultCurrentSha, commitUnixTime as defaultCommitUnixTime, commitsBetween as defaultCommitsBetween } from './git-ops';
import {
  evaluateDeployStaleness,
  deployStalenessThresholdsFromEnv,
  type DeployStalenessThresholds,
} from './green-checkpoint';

// ─── rating → gate verdict classification ──────────────────────────────────────────

/** Ratings this adapter treats as a full PASS for gating purposes. */
const GATE_PASS_RATINGS = new Set(['pass', 'healthy', 'good', 'yes', 'green', 'exemplary', 'exceptional']);
/** Ratings that mean "not yet assessable" — distinct from a real FAIL. */
const GATE_UNKNOWN_RATINGS = new Set(['unknown']);
// Everything else — fail/broken/bad/no/red/severe, AND partial/degraded/mixed/warn —
// classifies FAIL: a release gate must not silently treat "partial"/"degraded" as good
// enough to GO (an averaged score is fine for a trend; a gate needs a crisp cutoff).

/** PURE: classify one rubric criterion rating into the gate's 3-way raw verdict. */
export function classifyRatingForGate(rating: string): ComponentRawVerdict {
  const key = rating.trim().toLowerCase();
  if (GATE_PASS_RATINGS.has(key)) return 'pass';
  if (GATE_UNKNOWN_RATINGS.has(key)) return 'unknown';
  return 'fail';
}

const VERDICT_SEVERITY: Record<ComponentRawVerdict, number> = { pass: 0, unknown: 1, fail: 2 };

function formatInstrumentContractFailure(contract: ScorecardInstrumentContractEvaluation): string {
  const checks: Array<[label: string, values: string[]]> = [
    ['missing bindings', contract.missingBindings],
    ['duplicate bindings', contract.duplicateBindings],
    ['missing snapshots', contract.missingSnapshots],
    ['extra snapshots', contract.extraSnapshots],
    ['stale snapshots', contract.staleSnapshots],
    ['window mismatches', contract.windowMismatches],
    ['verdict mismatches', contract.verdictMismatches],
  ];
  const failures = checks.filter(([, values]) => values.length > 0);
  return failures.length > 0
    ? failures.map(([label, values]) => `${label}: ${values.join(', ')}`).join('; ')
    : 'the contract validator rejected the scorecard';
}

/** PURE: the worst-case verdict across a scorecard's ratings, with the criterion that
 *  produced it. A release gate does not average away one broken/unknown criterion —
 *  any single non-pass criterion sinks the whole component. */
export function worstCaseVerdict(
  ratings: Record<string, { rating: string }>,
): { verdict: ComponentRawVerdict; worstKey: string | null; worstRating: string | null } {
  let verdict: ComponentRawVerdict = 'pass';
  let worstKey: string | null = null;
  let worstRating: string | null = null;
  for (const [key, entry] of Object.entries(ratings)) {
    const v = classifyRatingForGate(entry.rating);
    if (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[verdict]) {
      verdict = v;
      worstKey = key;
      worstRating = entry.rating;
    }
  }
  return { verdict, worstKey, worstRating };
}

// ─── rubric-verdict component ───────────────────────────────────────────────────────

/** Mirrors rubric-staleness-watchdog.ts's default alert threshold (EI-12149) — the same
 *  "how long may a release-gating rubric go ungraded" policy, applied here as the
 *  component's staleness window instead of a separate alert. */
export const DEFAULT_RUBRIC_STALE_AFTER_MS = 6 * 60 * 60_000;

export interface RubricComponentDeps {
  getRubric?: typeof defaultGetRubric;
  listScorecards?: typeof defaultListScorecards;
  /** Injectable clock for the persisted scorecard instrument-contract check. */
  nowMs?: () => number;
  /** WI-5277: read the LIVE bg-host generation boundary, to judge whether the latest
   *  scorecard's generation still exists. Defaults to the real systemd read. */
  readBgHostActiveEnterMs?: () => Promise<number | null>;
}

export interface RubricComponentOpts {
  /** Default true — a release-gating rubric normally gates GO. */
  mandatory?: boolean;
  /** Default {@link DEFAULT_RUBRIC_STALE_AFTER_MS}. */
  maxAgeMs?: number;
  sourceHive?: string;
  deps?: RubricComponentDeps;
}

/**
 * Build a `ComponentSpec` that reduces one rubric's LATEST COMPLETE scorecard to a
 * pass/fail/unknown verdict. 'unknown' when: the rubric doesn't resolve, isn't
 * `active` (not ratified — grading an unratified draft can never authorize GO), has no
 * scorecard on record, its latest scorecard is INCOMPLETE (missing/extra keys — never
 * misread an incomplete card's happenstance-empty gaps as "all rated"), or (WI-5277) that
 * scorecard graded a GENERATION THAT HAS SINCE ENDED.
 * `gradedGeneration` (when the scorecard carries one) becomes this component's `lineage`
 * — both its `sha` AND its `generation` boundary — so a profile-level `expectedLineage`
 * mismatch is caught by the evaluator.
 */
export function rubricReleaseComponent(rubricRef: string, opts: RubricComponentOpts = {}): ComponentSpec {
  const mandatory = opts.mandatory ?? true;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RUBRIC_STALE_AFTER_MS;
  const getRubricFn = opts.deps?.getRubric ?? defaultGetRubric;
  const listScorecardsFn = opts.deps?.listScorecards ?? defaultListScorecards;
  const nowMsFn = opts.deps?.nowMs ?? Date.now;
  const readBoundaryFn = opts.deps?.readBgHostActiveEnterMs ?? defaultReadBgHostActiveEnterMs;

  return {
    key: `rubric:${rubricRef}`,
    title: `Rubric verdict — ${rubricRef}`,
    mandatory,
    maxAgeMs,
    async check(): Promise<ComponentCheckResult> {
      const now = new Date().toISOString();
      const rubric = await getRubricFn(rubricRef);
      if (!rubric) {
        return { verdict: 'unknown', reason: `rubric '${rubricRef}' not found`, measuredAt: now, evidence: [] };
      }
      if (rubric.status !== 'active') {
        return {
          verdict: 'unknown',
          reason: `rubric '${rubricRef}' is not ratified (status: ${rubric.status})`,
          measuredAt: now,
          evidence: [],
        };
      }
      const rows: ScorecardRow[] = await listScorecardsFn({ rubricRef, sourceHive: opts.sourceHive, limit: 1 });
      const latest = rows[0];
      if (!latest) {
        return { verdict: 'unknown', reason: `no scorecard on record for '${rubricRef}'`, measuredAt: now, evidence: [] };
      }
      // WI-5277: carry the generation BOUNDARY on the lineage stamp, not the sha alone.
      // LineageStamp already declares `generation`; leaving it unset made a restart that
      // did NOT move the sha invisible to a profile's expectedLineage check — the exact
      // shape of EI-14957 (hostStartedAt 14:39:17Z → 17:25:32Z, sha unchanged 7beca0c677).
      const lineage = latest.gradedGeneration
        ? { sha: latest.gradedGeneration.deployedSha, generation: latest.gradedGeneration.hostStartedAt }
        : null;
      const evidence = [{ ref: latest.issueId, kind: 'scorecard', detail: { sourceHive: latest.sourceHive ?? null } }];
      // WI-5277: dead evidence can never authorize GO. A scorecard graded against a
      // generation that has since ENDED is exactly as unusable as an incomplete or
      // unratified one, so it reports 'unknown' — blocking a mandatory component instead
      // of silently assembling a GO from a stale 6/6. This cannot be delegated to
      // expectedLineage: that only fires when a profile declares one, whereas the
      // 2026-07-17 void needed no configuration to happen. The boundary is read ONLY when
      // there is a stamp to compare it against.
      const gradedBoundary = latest.gradedGeneration?.hostStartedAt ?? null;
      const freshness = gradedBoundary
        ? compareGenerationFreshness(gradedBoundary, await readBoundaryFn().catch(() => null))
        : null;
      if (freshness?.status === 'stale') {
        return {
          verdict: 'unknown',
          reason: `latest scorecard for '${rubricRef}' graded a generation that no longer exists — ${freshness.reason}`,
          measuredAt: latest.createdAt,
          evidence,
          lineage,
        };
      }
      if (!latest.rubricResolved || latest.missingKeys.length > 0 || latest.extraKeys.length > 0) {
        return {
          verdict: 'unknown',
          reason:
            `latest scorecard for '${rubricRef}' is INCOMPLETE ` +
            `(missing: ${latest.missingKeys.join(', ') || 'none'}; extra: ${latest.extraKeys.join(', ') || 'none'})`,
          measuredAt: latest.createdAt,
          evidence,
          lineage,
        };
      }
      // Release-gating scorecards written before the typed emission path can still be
      // persisted in the historical issue ledger. Re-check the instrument contract on
      // this consumer boundary so a lucky/hand-authored rating cannot authorize GO just
      // because scorecards:evaluate/emit rejected the same shape at write time.
      const instrumentContract = evaluateScorecardInstrumentContract({
        rubric,
        ratings: latest.ratings,
        instrumentSnapshots: latest.instrumentSnapshots,
        nowMs: nowMsFn(),
      });
      if (rubric.releaseGating && !instrumentContract.valid) {
        return {
          verdict: 'unknown',
          reason:
            `latest scorecard for '${rubricRef}' has an invalid instrument contract — ` +
            formatInstrumentContractFailure(instrumentContract),
          measuredAt: latest.createdAt,
          evidence,
          lineage,
        };
      }
      const { verdict, worstKey, worstRating } = worstCaseVerdict(latest.ratings);
      return {
        verdict,
        reason:
          verdict === 'pass'
            ? `all ${Object.keys(latest.ratings).length} criteria pass`
            : `criterion '${worstKey}' rated '${worstRating}'`,
        measuredAt: latest.createdAt,
        evidence,
        lineage,
      };
    },
  };
}

// ─── hard operational gate: deploy-pin staleness ───────────────────────────────────

export interface DeployStalenessGateDeps {
  /** Resolve the DEPLOYED sha (the running generation's identity). Defaults to
   *  readRunningGeneration().deployedSha. */
  deployedSha?: () => Promise<string | null>;
  currentSha?: typeof defaultCurrentSha;
  commitUnixTime?: typeof defaultCommitUnixTime;
  commitsBetween?: typeof defaultCommitsBetween;
}

export interface DeployStalenessGateOpts {
  /** The integration-tree repo path git-ops reads. Defaults to
   *  PAPERCUSP_INTEGRATION_ROOT, else process.cwd(). */
  repo?: string;
  mandatory?: boolean;
  thresholds?: DeployStalenessThresholds;
  deps?: DeployStalenessGateDeps;
}

/**
 * Build the hard-gate `ComponentSpec` wrapping the existing (previously unwired)
 * `evaluateDeployStaleness` pure decision: is the deployed pin too old / too many
 * commits behind the integration tip? Reuses `git-ops.ts`'s commit primitives to
 * measure `pinAgeMs`/`commitsBehind` live — no new git plumbing.
 */
export function deployStalenessGateComponent(opts: DeployStalenessGateOpts = {}): ComponentSpec {
  const repo = opts.repo ?? process.env.PAPERCUSP_INTEGRATION_ROOT ?? process.cwd();
  const mandatory = opts.mandatory ?? true;
  const deployedShaFn =
    opts.deps?.deployedSha ?? (async () => (await defaultReadRunningGeneration()).deployedSha);
  const currentShaFn = opts.deps?.currentSha ?? defaultCurrentSha;
  const commitUnixTimeFn = opts.deps?.commitUnixTime ?? defaultCommitUnixTime;
  const commitsBetweenFn = opts.deps?.commitsBetween ?? defaultCommitsBetween;

  return {
    key: 'gate:deploy-staleness',
    title: 'Deploy pin staleness gate',
    mandatory,
    async check(): Promise<ComponentCheckResult> {
      const now = new Date().toISOString();
      const deployedSha = await deployedShaFn();
      if (!deployedSha) {
        return { verdict: 'unknown', reason: 'could not resolve the deployed sha', measuredAt: now, evidence: [] };
      }
      const [candidateSha, commitTimeSec] = await Promise.all([
        currentShaFn(repo),
        commitUnixTimeFn(repo, deployedSha),
      ]);
      const pinAgeMs = Date.now() - commitTimeSec * 1000;
      const commitsBehind = (await commitsBetweenFn(repo, deployedSha, candidateSha)).length;
      const thresholds = opts.thresholds ?? deployStalenessThresholdsFromEnv();
      const verdict = evaluateDeployStaleness({ pinAgeMs, commitsBehind }, thresholds);
      return {
        verdict: verdict.alarm ? 'fail' : 'pass',
        reason: verdict.alarm
          ? verdict.message
          : `deploy pin ${deployedSha.slice(0, 12)} is ${Math.round(pinAgeMs / 3_600_000)}h old, ${commitsBehind} commit(s) behind candidate`,
        measuredAt: now,
        evidence: [{ ref: deployedSha, kind: 'git-sha', detail: { pinAgeMs, commitsBehind, candidateSha } }],
        lineage: { sha: deployedSha },
      };
    },
  };
}

// ─── installed Windows smoke freshness gate ────────────────────────────────────────

export const WINDOWS_SMOKE_FRESHNESS_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const WINDOWS_SMOKE_SUCCESS_MARKER_FILENAME = 'latest-windows-smoke.json';
const WINDOWS_SMOKE_SUCCESS_SCHEMA = 'papercusp-windows-smoke-success/v1';

export interface WindowsSmokeFreshnessDeps {
  readMarker?: (markerPath: string) => Promise<string | null>;
  nowMs?: () => number;
}

export interface WindowsSmokeFreshnessOpts {
  markerPath?: string;
  deps?: WindowsSmokeFreshnessDeps;
}

function defaultWindowsSmokeMarkerPath(): string {
  const root =
    process.env.PAPERCUSP_RELEASE_RETENTION_ROOT ??
    path.join(os.homedir(), '.papercusp', 'release-retention');
  return path.join(root, WINDOWS_SMOKE_SUCCESS_MARKER_FILENAME);
}

async function readWindowsSmokeMarker(markerPath: string): Promise<string | null> {
  try {
    return await readFile(markerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A missing or malformed marker refuses GO; a valid pass is subject to the
 *  shared evaluator's seven-day staleness policy. The release-artifacts helper
 *  writes this watermark only after validating a successful Windows install. */
export function windowsSmokeFreshnessComponent(opts: WindowsSmokeFreshnessOpts = {}): ComponentSpec {
  const markerPath = opts.markerPath ?? defaultWindowsSmokeMarkerPath();
  const readMarker = opts.deps?.readMarker ?? readWindowsSmokeMarker;
  const nowMs = opts.deps?.nowMs ?? Date.now;

  return {
    key: 'gate:windows-smoke-freshness',
    title: 'Windows installed-artifact smoke freshness',
    mandatory: true,
    maxAgeMs: WINDOWS_SMOKE_FRESHNESS_MAX_AGE_MS,
    async check(): Promise<ComponentCheckResult> {
      const measuredNow = nowMs();
      const now = new Date(measuredNow).toISOString();
      const raw = await readMarker(markerPath);
      if (raw === null) {
        return { verdict: 'unknown', reason: 'no successful Windows smoke watermark exists', measuredAt: now, evidence: [] };
      }

      let marker: Record<string, unknown>;
      try {
        marker = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return { verdict: 'unknown', reason: 'Windows smoke watermark is not valid JSON', measuredAt: now, evidence: [] };
      }
      const { schemaVersion, result, platform, tag, version, buildSha, verifiedAtUtc } = marker;
      if (
        schemaVersion !== WINDOWS_SMOKE_SUCCESS_SCHEMA ||
        result !== 'pass' ||
        platform !== 'windows' ||
        typeof tag !== 'string' ||
        typeof version !== 'string' ||
        typeof buildSha !== 'string' ||
        typeof verifiedAtUtc !== 'string' ||
        !verifiedAtUtc.endsWith('Z')
      ) {
        return { verdict: 'unknown', reason: 'Windows smoke watermark is malformed or not a verified pass', measuredAt: now, evidence: [] };
      }
      const verifiedMs = Date.parse(verifiedAtUtc);
      if (!Number.isFinite(verifiedMs) || verifiedMs > measuredNow) {
        return { verdict: 'unknown', reason: 'Windows smoke watermark has an invalid or future timestamp', measuredAt: now, evidence: [] };
      }

      return {
        verdict: 'pass',
        reason: `latest Windows smoke passed for ${tag} at ${verifiedAtUtc}`,
        measuredAt: verifiedAtUtc,
        evidence: [{
          ref: markerPath,
          kind: 'smoke-success-watermark',
          detail: { tag, version, buildSha },
        }],
      };
    },
  };
}

// ─── the assembled papercusp profile ────────────────────────────────────────────────

export const PAPERCUSP_RELEASE_PROFILE_REF = 'papercusp-public-release-readiness';

export interface BuildPapercuspReleaseProfileDeps {
  listRubrics?: typeof defaultListRubrics;
  readRunningGeneration?: typeof defaultReadRunningGeneration;
}

export interface BuildPapercuspReleaseProfileOpts {
  profileRef?: string;
  /** Extra components (e.g. future P-007/P-008 component rubrics or gates) to compose
   *  alongside the auto-discovered releaseGating rubrics + the deploy-staleness gate. */
  extraComponents?: ComponentSpec[];
  rubricOpts?: Omit<RubricComponentOpts, 'mandatory'>;
  gateOpts?: DeployStalenessGateOpts;
  deps?: BuildPapercuspReleaseProfileDeps;
}

/**
 * Assemble the papercusp release profile: every ACTIVE `releaseGating` rubric (auto-
 * discovered — a newly-ratified release-gating rubric is picked up with no code
 * change) + the deploy-staleness hard gate, stamped with the RUNNING generation as
 * `expectedLineage` so evidence graded against a stale/different generation is
 * refused as 'lineage-mismatch'.
 */
export async function buildPapercuspReleaseProfile(
  opts: BuildPapercuspReleaseProfileOpts = {},
): Promise<ReleaseProfileSpec> {
  const listRubricsFn = opts.deps?.listRubrics ?? defaultListRubrics;
  const readRunningGenerationFn = opts.deps?.readRunningGeneration ?? defaultReadRunningGeneration;

  const [releaseGatingRubrics, generation] = await Promise.all([
    listRubricsFn({ status: 'active' }).then((rows) => rows.filter((r) => r.releaseGating === true)),
    readRunningGenerationFn(),
  ]);

  // Reuse the Rubric objects listRubrics already fetched instead of a redundant
  // per-component getRubric round-trip — resolve by id from this same read unless the
  // caller explicitly injected its own getRubric (e.g. a test fixture).
  const rubricById = new Map(releaseGatingRubrics.map((r) => [r.rubricId, r]));
  const rubricDeps = {
    ...opts.rubricOpts?.deps,
    getRubric: opts.rubricOpts?.deps?.getRubric ?? (async (ref: string) => rubricById.get(ref) ?? null),
  };

  return {
    profileRef: opts.profileRef ?? PAPERCUSP_RELEASE_PROFILE_REF,
    ...(generation.deployedSha ? { expectedLineage: { sha: generation.deployedSha } } : {}),
    components: [
      ...releaseGatingRubrics.map((r) =>
        rubricReleaseComponent(r.rubricId, { ...opts.rubricOpts, deps: rubricDeps }),
      ),
      deployStalenessGateComponent(opts.gateOpts),
      ...(opts.extraComponents ?? []),
    ],
  };
}

/** Build + evaluate the papercusp release profile in one call — the entry point
 *  WI-3548's GO/NO-GO synthesis consumes. `evaluateOpts` threads through to the
 *  generic evaluator (e.g. an injectable `now` for deterministic tests). */
export async function evaluatePapercuspReleaseProfile(
  opts: BuildPapercuspReleaseProfileOpts & { evaluateOpts?: EvaluateReleaseProfileOpts } = {},
): Promise<ReleaseProfileVerdict> {
  const spec = await buildPapercuspReleaseProfile(opts);
  return evaluateReleaseProfile(spec, opts.evaluateOpts);
}

// ─── the PUBLIC AUTO-LOOP release profile ───────────────────────────────────────────
//
// rubric-system-and-auto-loop-release-profile-2026-07-15 P-008. `buildPapercuspReleaseProfile`
// above auto-discovers EVERY active releaseGating rubric in the workspace — which, now that
// per-product rubrics exist (desktop-voice-release-readiness, papercup-chat-release-readiness,
// mobile-app-release-readiness, …), would mix unrelated products into one monolithic GO/NO-GO.
// The auto-loop product needs its OWN scoped profile: the fixed live rubric set, the
// strict live deploy-staleness gate, and the installed-Windows-smoke freshness gate —
// nothing else auto-discovered in.
//
// NOTE (WI-5379, 2026-08-12): this profile was authored when the product was
// "Mug → Cup → Kettle → Blender". The Mug/Cup/Kettle tier is RETIRED (2026-08-09); what
// remains of the auto-loop is Blender + Scout plus the shared release/autonomy surface.
// See AUTOLOOP_COMPONENT_RUBRIC_REFS below for the removed legs and why.

export const AUTOLOOP_RELEASE_PROFILE_REF = 'papercusp-autoloop-public-release-readiness';

/** The exact rubric refs this profile composes — Blender (P-006) + the auto-loop
 *  component rubrics P-007 ratified that still measure a LIVE subsystem. A fixed list,
 *  not auto-discovery: this profile is scoped to ONE product, not "every releaseGating
 *  rubric that happens to exist".
 *
 *  WI-5379 (2026-08-12): the Mug/Cup/Kettle tier was retired on 2026-08-09
 *  (plan retire-mug-kettle-su-only-2026-08-09 D-001; the `papercusp-mug-kettle-system`
 *  flag is DELETED, not merely default-OFF — libs/flags/src/types.ts:1081 — and
 *  cup:spawn / kettle:* / curation:state-of-pot now REFUSE). Its three component
 *  rubrics went with it:
 *      mug-pot-coordination-health · cup-lifecycle-durability · kettle-supervision-health
 *  They are removed here because a mandatory component that CANNOT be graded is not a
 *  strict gate, it is a permanently-red one: each had ZERO complete scorecards on record
 *  (measured 2026-08-12 over a 7-day window), and no honest scorecard was reachable —
 *  the subsystem they grade no longer runs. Blender and Scout survive the retirement
 *  (D-001) and `pot-coordination-health` is a DIFFERENT, still-live rubric covering the
 *  shared pot substrate (D-003) — neither is affected.
 *
 *  Retiring a component here is deliberately a code change, not auto-discovery: the
 *  fixed list is what stops a future subsystem from silently gating this release. */
export const AUTOLOOP_COMPONENT_RUBRIC_REFS = [
  'blender-release-readiness',
  'autonomy-owner-controls',
  'release-integrity-health',
  'production-soak-health',
] as const;

export interface BuildAutoloopReleaseProfileDeps {
  getRubric?: typeof defaultGetRubric;
  listScorecards?: typeof defaultListScorecards;
  readRunningGeneration?: typeof defaultReadRunningGeneration;
}

export interface BuildAutoloopReleaseProfileOpts {
  profileRef?: string;
  /** Extra components to compose alongside the fixed rubric set and operational gates. */
  extraComponents?: ComponentSpec[];
  rubricOpts?: Omit<RubricComponentOpts, 'mandatory'>;
  gateOpts?: DeployStalenessGateOpts;
  windowsSmokeOpts?: WindowsSmokeFreshnessOpts;
  deps?: BuildAutoloopReleaseProfileDeps;
}

/**
 * Assemble the public auto-loop release profile: the fixed rubric set
 * ({@link AUTOLOOP_COMPONENT_RUBRIC_REFS}), deploy-staleness hard gate, and Windows
 * installed-smoke freshness gate, stamped with the RUNNING generation as
 * `expectedLineage` so evidence graded against a stale/different generation is refused
 * as 'lineage-mismatch', exactly like the general profile above.
 */
export async function buildAutoloopReleaseProfile(
  opts: BuildAutoloopReleaseProfileOpts = {},
): Promise<ReleaseProfileSpec> {
  const readRunningGenerationFn = opts.deps?.readRunningGeneration ?? defaultReadRunningGeneration;
  const generation = await readRunningGenerationFn();

  // Merge opts.rubricOpts.deps FIRST, then fall back to the profile-level opts.deps /
  // module defaults — a caller injecting rubricOpts.deps.listScorecards (the per-test
  // fixture path) must win over the generic default, exactly like buildPapercuspReleaseProfile.
  const rubricDeps = {
    ...opts.rubricOpts?.deps,
    getRubric: opts.rubricOpts?.deps?.getRubric ?? opts.deps?.getRubric ?? defaultGetRubric,
    listScorecards: opts.rubricOpts?.deps?.listScorecards ?? opts.deps?.listScorecards ?? defaultListScorecards,
  };

  return {
    profileRef: opts.profileRef ?? AUTOLOOP_RELEASE_PROFILE_REF,
    ...(generation.deployedSha ? { expectedLineage: { sha: generation.deployedSha } } : {}),
    components: [
      ...AUTOLOOP_COMPONENT_RUBRIC_REFS.map((ref) => rubricReleaseComponent(ref, { ...opts.rubricOpts, deps: rubricDeps })),
      deployStalenessGateComponent(opts.gateOpts),
      windowsSmokeFreshnessComponent(opts.windowsSmokeOpts),
      ...(opts.extraComponents ?? []),
    ],
  };
}

/** Build + evaluate the public auto-loop release profile in one call. `evaluateOpts`
 *  threads through to the generic evaluator (e.g. an injectable `now` for deterministic
 *  tests). */
export async function evaluateAutoloopReleaseProfile(
  opts: BuildAutoloopReleaseProfileOpts & { evaluateOpts?: EvaluateReleaseProfileOpts } = {},
): Promise<ReleaseProfileVerdict> {
  const spec = await buildAutoloopReleaseProfile(opts);
  return evaluateReleaseProfile(spec, opts.evaluateOpts);
}

// P-519/F8: expose the current capability interpretation alongside the profile
// evaluator so release consumers share one evidence model and one import seam.
export {
  appendReadinessHistory,
  buildCurrentReadinessManifest,
  currentReadinessDependencyGraph,
  deriveCurrentReadinessManifest,
  deriveReadinessDependencyGraph,
  readinessTable,
  renderReadinessTable,
  serializeCurrentReadinessManifest,
} from './current-readiness-manifest';
export type {
  BuildCurrentReadinessManifestOptions,
  CurrentReadinessManifest,
  CurrentReadinessRow,
  ReadinessArtifactIdentity,
  ReadinessCapabilityInput,
  ReadinessDependencyEdge,
  ReadinessDependencyGraph,
  ReadinessDependencyNode,
  ReadinessEvidence,
  ReadinessFreshness,
  ReadinessHistoryEntry,
  ReadinessState,
} from './current-readiness-manifest';
