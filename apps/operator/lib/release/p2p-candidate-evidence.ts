/**
 * P-521 F7 — COMPUTED candidate provenance and COMPUTED journey results
 * (plan p2p-public-release-endgame-2026-09-01, D-038 / D-080, WI-10002524).
 *
 * `p2p-candidate-manifest.ts` turns a candidate provenance plus a map of journey
 * results into the P-519 current readiness manifest. Both inputs used to be
 * hand-assembled JSON, so the manifest was only as honest as whoever typed them.
 * This module DERIVES both from records the pipeline already writes:
 *
 *   - one `build-provenance.json` per build leg (papercusp-desktop/bin/emit-build-provenance.sh),
 *   - the release ledger row (`harness_shared.releases`),
 *   - optional fresh re-hashes of the artifact bytes on disk,
 *   - the recorded `release:cut op:run` invocation (the build command),
 *   - `operational-test-evidence` documents (docs/evidence/*.json) from the physical journeys.
 *
 * Nothing here is inferred to a pass. A provenance contradiction is a `fail` check;
 * a gap (for example, an artifact vouched for only by the ledger) is a `warn`.
 * An evidence document counts toward a journey only when it DECLARES the journey
 * (`p521Journey` / `p521Journeys`) AND names at least one artifact sha256 that is a
 * member of this candidate. A declared document measured on other bytes still
 * surfaces, as `lineage-mismatch`, never as a pass. A candidate-bound document that
 * declares no journey is reported as unmapped, never counted.
 *
 * A journey may also be declared OUTSIDE the measurement record, by a separate
 * `p521-journey-mapping` document that names the evidence path AND its sha256. This keeps
 * the acceptance call (which journeys a run covers) apart from the measurement it points
 * at: editing a bound evidence document would change the bytes its spec-evidence bindings
 * pin. A mapping applies only while the evidence bytes still match its sha256. A stale,
 * duplicated or contradicting mapping is reported and never counts.
 *
 * Pure functions only: file and database I/O live in `run-p2p-candidate-manifest.ts`.
 */
import { createHash } from 'node:crypto';
import type { EvidenceRef } from '@papercusp/release-profile';
import {
  candidateArtifactDigest,
  P521_JOURNEYS,
  type P2pCandidateArtifact,
  type P2pCandidateProvenance,
  type P2pJourneyResult,
} from './p2p-candidate-manifest';

export const CANDIDATE_PROVENANCE_SCHEMA_VERSION = 1 as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface LegBuildArtifact {
  /** Path relative to the leg's provenance dir (e.g. `deb/App_0.0.25_amd64.deb`) or a basename. */
  name: string;
  bytes?: number;
  sha256: string;
  /** Whether a co-located minisign `.sig` existed at emit time. */
  sig?: boolean;
}

export interface LegSourceRepository {
  label: string;
  gitHead: string;
  files?: readonly unknown[];
}

/** The subset of emit-build-provenance.sh's schema this module reads. */
export interface LegBuildProvenance {
  version: string;
  buildSha: string;
  reused: boolean;
  gitHead: string;
  gitDirty: boolean;
  gitHeadAtEmit?: string;
  gitDirtyAtEmit?: boolean;
  dirtySource?: { status?: string; repositories?: readonly LegSourceRepository[] } | null;
  toolchain?: Record<string, unknown> | null;
  releaseHostSha256?: string;
  sidecar?: { gitHead?: string; builtAtUtc?: string; serveMjsSha256?: string } | null;
  builtAtUtc?: string;
  artifacts: readonly LegBuildArtifact[];
}

export interface LegProvenanceInput {
  /** Leg label, e.g. `linux`, `mac`, `windows`. */
  leg: string;
  /** Where the record was read from (display only). */
  path: string;
  /** sha256 of the provenance file's own bytes, when the caller hashed it. */
  fileSha256?: string;
  record: LegBuildProvenance;
}

export interface ReleaseLedgerArtifact {
  name: string;
  sha256: string;
  size?: number;
  product?: string;
  platform?: string;
}

/** One `harness_shared.releases` row. */
export interface ReleaseLedgerRecord {
  version: string;
  channel: string;
  gitSha: string | null;
  cutAt?: string | null;
  publishedAt?: string | null;
  artifacts: readonly ReleaseLedgerArtifact[];
}

/** A fresh sha256 of artifact bytes on disk, taken by the caller. */
export interface ArtifactRehash {
  name: string;
  sha256: string;
  bytes: number;
  path: string;
}

/** The recorded invocation that built the candidate (a `release:cut op:run`). */
export interface BuildCommandRecord {
  tool: string;
  invocationId?: string | number;
  invokedAt?: string;
  args: Record<string, unknown>;
  servingBuildSha?: string | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type ProvenanceCheckStatus = 'pass' | 'warn' | 'fail';

export interface ProvenanceCheck {
  id: string;
  status: ProvenanceCheckStatus;
  detail: string;
}

export interface CandidateArtifactRecord {
  /** Basename: the identity `candidateArtifactDigest` hashes. */
  name: string;
  sha256: string;
  bytes: number | null;
  /** Which records vouch for these bytes: `leg:<leg>`, `ledger`, `rehash`. */
  sources: string[];
  sig: boolean | null;
}

export interface CandidateLegSummary {
  leg: string;
  path: string;
  fileSha256: string | null;
  version: string;
  buildSha: string;
  desktopHead: string;
  workspaceHead: string | null;
  gitDirty: boolean;
  gitDirtyAtEmit: boolean | null;
  reused: boolean;
  builtAtUtc: string | null;
  toolchain: Record<string, unknown> | null;
  releaseHostSha256: string | null;
  sidecar: { gitHead: string | null; serveMjsSha256: string | null } | null;
  artifactCount: number;
}

export interface CandidateProvenanceReport {
  schemaVersion: typeof CANDIDATE_PROVENANCE_SCHEMA_VERSION;
  version: string;
  channel: string;
  sourceSha: string;
  desktopSha: string | null;
  buildSha: string | null;
  candidateDigest: string;
  artifacts: CandidateArtifactRecord[];
  legs: CandidateLegSummary[];
  ledger: { gitSha: string | null; cutAt: string | null; publishedAt: string | null; artifactCount: number } | null;
  buildCommand: BuildCommandRecord | null;
  checks: ProvenanceCheck[];
  /** True when no check failed. Warnings are gaps to close, not contradictions. */
  ok: boolean;
}

/** Superset of `P2pCandidateProvenance`: the manifest CLI accepts it unchanged. */
export interface DerivedCandidateProvenance extends P2pCandidateProvenance {
  provenance: CandidateProvenanceReport;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where}: '${key}' must be a non-empty string`);
  return value;
}

function requireBoolean(obj: Record<string, unknown>, key: string, where: string): boolean {
  const value = obj[key];
  if (typeof value !== 'boolean') throw new Error(`${where}: '${key}' must be a boolean`);
  return value;
}

/** Validate one emit-build-provenance.sh record. Throws on a malformed record. */
export function parseLegBuildProvenance(value: unknown, where: string): LegBuildProvenance {
  if (!isRecord(value)) throw new Error(`${where}: build provenance must be a JSON object`);
  const artifactsRaw = value.artifacts;
  if (!Array.isArray(artifactsRaw) || artifactsRaw.length === 0) {
    throw new Error(`${where}: 'artifacts' must be a non-empty array`);
  }
  const artifacts = artifactsRaw.map((raw, i): LegBuildArtifact => {
    if (!isRecord(raw)) throw new Error(`${where}: artifacts[${i}] must be an object`);
    const name = requireString(raw, 'name', `${where} artifacts[${i}]`);
    const sha256 = requireString(raw, 'sha256', `${where} artifacts[${i}]`);
    if (!SHA256_HEX.test(sha256)) throw new Error(`${where}: artifact '${name}' has a malformed sha256`);
    return {
      name,
      sha256,
      ...(typeof raw.bytes === 'number' ? { bytes: raw.bytes } : {}),
      ...(typeof raw.sig === 'boolean' ? { sig: raw.sig } : {}),
    };
  });
  const dirty = value.dirtySource;
  const sidecar = value.sidecar;
  return {
    version: requireString(value, 'version', where),
    buildSha: requireString(value, 'buildSha', where),
    reused: requireBoolean(value, 'reused', where),
    gitHead: requireString(value, 'gitHead', where),
    gitDirty: requireBoolean(value, 'gitDirty', where),
    ...(typeof value.gitHeadAtEmit === 'string' ? { gitHeadAtEmit: value.gitHeadAtEmit } : {}),
    ...(typeof value.gitDirtyAtEmit === 'boolean' ? { gitDirtyAtEmit: value.gitDirtyAtEmit } : {}),
    dirtySource: isRecord(dirty)
      ? {
          ...(typeof dirty.status === 'string' ? { status: dirty.status } : {}),
          repositories: Array.isArray(dirty.repositories)
            ? dirty.repositories.filter(isRecord).map((repo) => ({
                label: String(repo.label ?? ''),
                gitHead: String(repo.gitHead ?? ''),
                files: Array.isArray(repo.files) ? repo.files : [],
              }))
            : [],
        }
      : null,
    toolchain: isRecord(value.toolchain) ? value.toolchain : null,
    ...(typeof value.releaseHostSha256 === 'string' ? { releaseHostSha256: value.releaseHostSha256 } : {}),
    sidecar: isRecord(sidecar)
      ? {
          ...(typeof sidecar.gitHead === 'string' ? { gitHead: sidecar.gitHead } : {}),
          ...(typeof sidecar.builtAtUtc === 'string' ? { builtAtUtc: sidecar.builtAtUtc } : {}),
          ...(typeof sidecar.serveMjsSha256 === 'string' ? { serveMjsSha256: sidecar.serveMjsSha256 } : {}),
        }
      : null,
    ...(typeof value.builtAtUtc === 'string' ? { builtAtUtc: value.builtAtUtc } : {}),
    artifacts,
  };
}

// ---------------------------------------------------------------------------
// Candidate provenance
// ---------------------------------------------------------------------------

export function artifactBasename(name: string): string {
  const trimmed = name.trim();
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function workspaceHeadOf(record: LegBuildProvenance): string | null {
  const repo = record.dirtySource?.repositories?.find((r) => r.label === 'workspace');
  return repo?.gitHead ? repo.gitHead : null;
}

function uniq(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(byCodePoint);
}

/** Locale-independent order: provenance bytes must not depend on the host's collation. */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface DeriveCandidateProvenanceOptions {
  version: string;
  channel: string;
  legs: readonly LegProvenanceInput[];
  ledger?: ReleaseLedgerRecord | null;
  rehashes?: readonly ArtifactRehash[];
  buildCommand?: BuildCommandRecord | null;
}

/**
 * Derive the candidate's provenance from its build records. The returned object is a
 * `P2pCandidateProvenance` (so it feeds `buildP2pCandidateManifest` directly) carrying a
 * `provenance` report of every cross-record check.
 */
export function deriveCandidateProvenance(options: DeriveCandidateProvenanceOptions): DerivedCandidateProvenance {
  const { version, channel, legs } = options;
  const ledger = options.ledger ?? null;
  const rehashes = options.rehashes ?? [];
  const buildCommand = options.buildCommand ?? null;
  if (legs.length === 0) throw new Error('at least one leg build-provenance record is required');
  const legNames = legs.map((l) => l.leg);
  if (new Set(legNames).size !== legNames.length) throw new Error(`duplicate leg label in: ${legNames.join(', ')}`);

  const checks: ProvenanceCheck[] = [];
  const check = (id: string, status: ProvenanceCheckStatus, detail: string) => checks.push({ id, status, detail });

  // --- source identity -------------------------------------------------------
  const workspaceHeads = uniq(legs.map((l) => workspaceHeadOf(l.record)).filter((h): h is string => !!h));
  const sourceSha = ledger?.gitSha ?? (workspaceHeads.length === 1 ? workspaceHeads[0] : null);
  if (!sourceSha || !GIT_SHA.test(sourceSha)) {
    throw new Error(
      `cannot identify the candidate source: ledger git_sha=${ledger?.gitSha ?? 'absent'}, leg workspace heads=[${workspaceHeads.join(', ')}]`,
    );
  }

  // version agreement
  const versionMismatch = [
    ...legs.filter((l) => l.record.version !== version).map((l) => `leg ${l.leg}=${l.record.version}`),
    ...(ledger && ledger.version !== version ? [`ledger=${ledger.version}`] : []),
    ...(ledger && ledger.channel !== channel ? [`ledger channel=${ledger.channel}`] : []),
  ];
  check(
    'version-agreement',
    versionMismatch.length ? 'fail' : 'pass',
    versionMismatch.length ? `expected ${version}/${channel}; got ${versionMismatch.join('; ')}` : `every leg${ledger ? ' and the ledger' : ''} record ${version}/${channel}`,
  );

  // workspace source revision per leg
  const sourceProblems: string[] = [];
  const sourceGaps: string[] = [];
  for (const l of legs) {
    const head = workspaceHeadOf(l.record);
    if (!head) sourceGaps.push(l.leg);
    else if (head !== sourceSha) sourceProblems.push(`leg ${l.leg} built workspace ${head}`);
  }
  check(
    'source-revision',
    sourceProblems.length ? 'fail' : sourceGaps.length ? 'warn' : 'pass',
    sourceProblems.length
      ? `candidate source is ${sourceSha} but ${sourceProblems.join('; ')}`
      : sourceGaps.length
        ? `leg(s) ${sourceGaps.join(', ')} record no workspace head at cut start; the others match ${sourceSha}`
        : `every leg captured workspace ${sourceSha} at cut start${ledger ? ' and the ledger agrees' : ''}`,
  );

  // desktop submodule pin + baked build sha
  const desktopHeads = uniq(legs.map((l) => l.record.gitHead));
  const buildShas = uniq(legs.map((l) => l.record.buildSha));
  const bakedMismatch = legs.filter((l) => !l.record.gitHead.startsWith(l.record.buildSha)).map((l) => l.leg);
  const pinOk = desktopHeads.length === 1 && buildShas.length === 1 && bakedMismatch.length === 0;
  check(
    'desktop-pin',
    pinOk ? 'pass' : 'fail',
    pinOk
      ? `every leg built desktop ${desktopHeads[0]} and baked buildSha ${buildShas[0]} (the /api/health identity)`
      : `desktop heads [${desktopHeads.join(', ')}], baked buildSha [${buildShas.join(', ')}]${bakedMismatch.length ? `, buildSha not a prefix of gitHead on ${bakedMismatch.join(', ')}` : ''}`,
  );

  // clean source at cut start
  const dirtyLegs = legs.filter(
    (l) => l.record.gitDirty || (l.record.dirtySource?.repositories ?? []).some((r) => (r.files?.length ?? 0) > 0),
  );
  const emitDirty = legs.filter((l) => l.record.gitDirtyAtEmit === true).map((l) => l.leg);
  check(
    'clean-source',
    dirtyLegs.length ? 'fail' : 'pass',
    dirtyLegs.length
      ? `source was dirty at cut start on ${dirtyLegs.map((l) => l.leg).join(', ')}`
      : `every leg built from a clean source at cut start${emitDirty.length ? ` (gitDirtyAtEmit=true on ${emitDirty.join(', ')}: the cutter's own post-preflight writes, recorded separately by the emitter)` : ''}`,
  );

  // built this cut, not salvaged
  const reusedLegs = legs.filter((l) => l.record.reused).map((l) => l.leg);
  check(
    'built-not-reused',
    reusedLegs.length ? 'fail' : 'pass',
    reusedLegs.length ? `salvaged (reused:true) artifacts on ${reusedLegs.join(', ')}: their label may not match their bytes` : 'every leg built its artifacts in this cut',
  );

  // sidecar payload identity
  const sidecarHeads = legs.filter((l) => l.record.sidecar?.gitHead).map((l) => ({ leg: l.leg, head: l.record.sidecar!.gitHead! }));
  const sidecarShas = uniq(legs.map((l) => l.record.sidecar?.serveMjsSha256).filter((s): s is string => !!s));
  const sidecarWrongSource = sidecarHeads.filter((s) => s.head !== sourceSha);
  const noSidecar = legs.filter((l) => !l.record.sidecar?.serveMjsSha256).map((l) => l.leg);
  check(
    'sidecar-payload',
    sidecarWrongSource.length || sidecarShas.length > 1 ? 'fail' : sidecarShas.length === 0 || noSidecar.length ? 'warn' : 'pass',
    sidecarWrongSource.length
      ? `sidecar built from ${sidecarWrongSource.map((s) => `${s.head} (leg ${s.leg})`).join(', ')}, not ${sourceSha}`
      : sidecarShas.length > 1
        ? `legs ship different serve.mjs bytes: ${sidecarShas.join(', ')}`
        : sidecarShas.length === 0
          ? 'no leg records its sidecar payload'
          : `serve.mjs ${sidecarShas[0]} from ${sourceSha}${noSidecar.length ? `; leg(s) ${noSidecar.join(', ')} record no sidecar block` : ' on every leg'}`,
  );

  // --- artifact set ------------------------------------------------------------
  const byName = new Map<string, CandidateArtifactRecord>();
  const conflicts: string[] = [];
  const add = (name: string, sha256: string, bytes: number | null, source: string, sig: boolean | null) => {
    const base = artifactBasename(name);
    const existing = byName.get(base);
    if (!existing) {
      byName.set(base, { name: base, sha256, bytes, sources: [source], sig });
      return;
    }
    if (existing.sha256 !== sha256) {
      conflicts.push(`${base}: ${existing.sources.join('+')}=${existing.sha256.slice(0, 12)} vs ${source}=${sha256.slice(0, 12)}`);
      return;
    }
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (existing.bytes === null && bytes !== null) existing.bytes = bytes;
    if (existing.sig === null && sig !== null) existing.sig = sig;
  };
  for (const l of legs) {
    for (const a of l.record.artifacts) add(a.name, a.sha256, a.bytes ?? null, `leg:${l.leg}`, a.sig ?? null);
  }
  for (const a of ledger?.artifacts ?? []) {
    if (!SHA256_HEX.test(a.sha256)) {
      conflicts.push(`${a.name}: ledger sha256 is malformed`);
      continue;
    }
    add(a.name, a.sha256, a.size ?? null, 'ledger', null);
  }
  const unknownRehash: string[] = [];
  const rehashMismatch: string[] = [];
  for (const r of rehashes) {
    const base = artifactBasename(r.name);
    const existing = byName.get(base);
    if (!existing) {
      unknownRehash.push(base);
      continue;
    }
    if (existing.sha256 !== r.sha256) rehashMismatch.push(`${base}: recorded ${existing.sha256.slice(0, 12)}, on disk ${r.sha256.slice(0, 12)}`);
    else if (!existing.sources.includes('rehash')) existing.sources.push('rehash');
  }
  check(
    'artifact-identity',
    conflicts.length ? 'fail' : 'pass',
    conflicts.length ? `one name, two byte identities: ${conflicts.join('; ')}` : `${byName.size} artifacts, each with exactly one sha256 across every record`,
  );
  check(
    'rehash',
    rehashMismatch.length ? 'fail' : rehashes.length === 0 ? 'warn' : unknownRehash.length ? 'warn' : 'pass',
    rehashMismatch.length
      ? `on-disk bytes differ from the record: ${rehashMismatch.join('; ')}`
      : rehashes.length === 0
        ? 'no artifact was re-hashed from disk; identity rests on the emitted records'
        : `${rehashes.length - unknownRehash.length} artifact(s) re-hashed from disk and match${unknownRehash.length ? `; ${unknownRehash.length} re-hashed file(s) are not in the candidate: ${unknownRehash.join(', ')}` : ''}`,
  );

  if (ledger) {
    const ledgerOnly = [...byName.values()].filter((a) => a.sources.length === 1 && a.sources[0] === 'ledger').map((a) => a.name);
    // Compare against what the BUILD recorded, not against `sourceSha` (which is itself
    // taken from the ledger when present, so that comparison could never fail).
    const ledgerSourceOk = workspaceHeads.every((head) => head === ledger.gitSha);
    check(
      'ledger-corroboration',
      !ledgerSourceOk ? 'fail' : ledgerOnly.length ? 'warn' : 'pass',
      !ledgerSourceOk
        ? `ledger git_sha ${ledger.gitSha} is not the workspace head the legs built (${workspaceHeads.join(', ')})`
        : ledgerOnly.length
          ? `vouched for ONLY by the ledger (no build record, no re-hash): ${ledgerOnly.join(', ')}`
          : `every one of the ${ledger.artifacts.length} ledger artifacts is corroborated by a build record or a fresh re-hash`,
    );
  } else {
    check('ledger-corroboration', 'warn', 'no release ledger row was supplied');
  }

  const unsigned = [...byName.values()].filter((a) => a.sig === false).map((a) => a.name);
  check(
    'signatures',
    unsigned.length ? 'warn' : 'pass',
    unsigned.length
      ? `no co-located updater .sig at emit time: ${unsigned.join(', ')} (D-019 signable set decides whether each is expected)`
      : 'every artifact with a recorded sig flag had its updater .sig',
  );

  // --- build command -------------------------------------------------------------
  if (!buildCommand) {
    check('build-command', 'warn', 'no recorded build invocation was supplied');
  } else {
    const argSha = buildCommand.args.sourceSha;
    const argVersion = buildCommand.args.version;
    const argChannel = buildCommand.args.channel;
    const problems = [
      ...(argSha !== sourceSha ? [`sourceSha=${String(argSha)}`] : []),
      ...(argVersion !== version ? [`version=${String(argVersion)}`] : []),
      ...(argChannel !== undefined && argChannel !== channel ? [`channel=${String(argChannel)}`] : []),
    ];
    const invokedMs = buildCommand.invokedAt ? Date.parse(buildCommand.invokedAt) : NaN;
    const earliestBuilt = Math.min(...legs.map((l) => (l.record.builtAtUtc ? Date.parse(l.record.builtAtUtc) : Infinity)));
    if (Number.isFinite(invokedMs) && Number.isFinite(earliestBuilt) && invokedMs > earliestBuilt) {
      problems.push(`invoked ${buildCommand.invokedAt} AFTER the first leg finished`);
    }
    check(
      'build-command',
      problems.length ? 'fail' : 'pass',
      problems.length
        ? `recorded ${buildCommand.tool} invocation ${String(buildCommand.invocationId ?? '')} disagrees: ${problems.join('; ')}`
        : `${buildCommand.tool} invocation ${String(buildCommand.invocationId ?? '')} at ${buildCommand.invokedAt ?? '?'} built ${version}/${channel} from ${sourceSha}`,
    );
  }

  const artifacts = [...byName.values()].sort((a, b) => byCodePoint(a.name, b.name));
  const candidateArtifacts: P2pCandidateArtifact[] = artifacts.map((a) => ({ name: a.name, sha256: a.sha256 }));
  const candidateDigest = candidateArtifactDigest(candidateArtifacts);

  const report: CandidateProvenanceReport = {
    schemaVersion: CANDIDATE_PROVENANCE_SCHEMA_VERSION,
    version,
    channel,
    sourceSha,
    desktopSha: desktopHeads.length === 1 ? desktopHeads[0] : null,
    buildSha: buildShas.length === 1 ? buildShas[0] : null,
    candidateDigest,
    artifacts,
    legs: legs.map((l) => ({
      leg: l.leg,
      path: l.path,
      fileSha256: l.fileSha256 ?? null,
      version: l.record.version,
      buildSha: l.record.buildSha,
      desktopHead: l.record.gitHead,
      workspaceHead: workspaceHeadOf(l.record),
      gitDirty: l.record.gitDirty,
      gitDirtyAtEmit: l.record.gitDirtyAtEmit ?? null,
      reused: l.record.reused,
      builtAtUtc: l.record.builtAtUtc ?? null,
      toolchain: l.record.toolchain ?? null,
      releaseHostSha256: l.record.releaseHostSha256 ?? null,
      sidecar: l.record.sidecar
        ? { gitHead: l.record.sidecar.gitHead ?? null, serveMjsSha256: l.record.sidecar.serveMjsSha256 ?? null }
        : null,
      artifactCount: l.record.artifacts.length,
    })),
    ledger: ledger
      ? { gitSha: ledger.gitSha, cutAt: ledger.cutAt ?? null, publishedAt: ledger.publishedAt ?? null, artifactCount: ledger.artifacts.length }
      : null,
    buildCommand,
    checks,
    ok: checks.every((c) => c.status !== 'fail'),
  };

  return { version, channel, sourceSha, artifacts: candidateArtifacts, provenance: report };
}

// ---------------------------------------------------------------------------
// Reproducibility
// ---------------------------------------------------------------------------

export interface ReproducibilityComparison {
  identical: string[];
  differing: { name: string; recorded: string; rebuilt: string }[];
  missingInRebuild: string[];
  extraInRebuild: string[];
  /** True only when every compared name is byte-identical and nothing is missing. */
  reproducible: boolean;
}

/** Compare recorded vs rebuilt artifact identities by basename. */
export function compareArtifactSets(
  recorded: readonly { name: string; sha256: string }[],
  rebuilt: readonly { name: string; sha256: string }[],
): ReproducibilityComparison {
  const rec = new Map(recorded.map((a) => [artifactBasename(a.name), a.sha256]));
  const reb = new Map(rebuilt.map((a) => [artifactBasename(a.name), a.sha256]));
  const identical: string[] = [];
  const differing: ReproducibilityComparison['differing'] = [];
  const missingInRebuild: string[] = [];
  for (const [name, sha] of [...rec].sort(([a], [b]) => byCodePoint(a, b))) {
    const other = reb.get(name);
    if (other === undefined) missingInRebuild.push(name);
    else if (other === sha) identical.push(name);
    else differing.push({ name, recorded: sha, rebuilt: other });
  }
  const extraInRebuild = [...reb.keys()].filter((name) => !rec.has(name)).sort();
  return {
    identical,
    differing,
    missingInRebuild,
    extraInRebuild,
    reproducible: identical.length > 0 && differing.length === 0 && missingInRebuild.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Journey evidence
// ---------------------------------------------------------------------------

export interface EvidenceDocInput {
  /** Repo-relative path of the evidence document. */
  path: string;
  /** sha256 of the document's bytes. */
  sha256: string;
  doc: unknown;
}

export type EvidenceBinding = 'this-candidate' | 'other-artifact';

/** `kind` of a document that declares journeys for an evidence document it does not modify. */
export const JOURNEY_MAPPING_KIND = 'p521-journey-mapping' as const;

export interface JourneyMappingOutcome {
  /** Repo-relative path of the mapping document. */
  path: string;
  evidencePath: string | null;
  evidenceSha256: string | null;
  journeys: string[];
  /** The authority recorded on the mapping (e.g. a plan decision id), if any. */
  decision: string | null;
  applied: boolean;
  reason: string;
}

export interface JourneyEvidenceBinding {
  path: string;
  sha256: string;
  journeys: string[];
  /** `inline` (the document declares its journeys) or the path of the mapping that did. */
  declaredBy: string;
  binding: EvidenceBinding;
  artifactSha256s: string[];
  verdict: P2pJourneyResult['verdict'];
  reason: string;
  measuredAt: string;
  observedPeers: string[];
  selected: boolean;
}

export interface DerivedJourneyEvidence {
  journeys: Record<string, P2pJourneyResult>;
  bindings: JourneyEvidenceBinding[];
  /** Candidate-bound evidence that declares no P-521 journey: reported, never counted. */
  unmapped: { path: string; sha256: string; name: string | null }[];
  /** Documents that could not be used at all, with why. */
  ignored: { path: string; reason: string }[];
  /** Every journey-mapping document considered, and whether it applied. */
  mappings: JourneyMappingOutcome[];
}

/** Every artifact sha256 an operational evidence document names as its subject. */
export function evidenceArtifactShas(doc: Record<string, unknown>): string[] {
  const subject = isRecord(doc.subject) ? doc.subject : {};
  const shas: string[] = [];
  for (const key of ['artifactSha256', 'debSha256']) {
    const value = subject[key];
    if (typeof value === 'string' && SHA256_HEX.test(value)) shas.push(value);
  }
  if (Array.isArray(subject.artifacts)) {
    for (const a of subject.artifacts) {
      if (isRecord(a) && typeof a.sha256 === 'string' && SHA256_HEX.test(a.sha256)) shas.push(a.sha256);
    }
  }
  return uniq(shas);
}

function declaredJourneys(doc: Record<string, unknown>): string[] | null {
  const many = doc.p521Journeys;
  const one = doc.p521Journey;
  const list = [
    ...(Array.isArray(many) ? many.filter((j): j is string => typeof j === 'string') : []),
    ...(typeof one === 'string' ? [one] : []),
  ];
  return list.length ? uniq(list) : null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = uniq([...a]).sort(byCodePoint);
  const y = uniq([...b]).sort(byCodePoint);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Parse one mapping document; a malformed one comes back with `applied:false` and why. */
function parseJourneyMapping(input: EvidenceDocInput, doc: Record<string, unknown>): JourneyMappingOutcome {
  const evidence = isRecord(doc.evidence) ? doc.evidence : {};
  const evidencePath = typeof evidence.path === 'string' && evidence.path.trim() ? evidence.path.trim() : null;
  const evidenceSha256 = typeof evidence.sha256 === 'string' && SHA256_HEX.test(evidence.sha256) ? evidence.sha256 : null;
  const journeys = declaredJourneys(doc) ?? [];
  const decision = typeof doc.decision === 'string' && doc.decision.trim() ? doc.decision.trim() : null;
  const problems = [
    ...(evidencePath ? [] : ['evidence.path missing']),
    ...(evidenceSha256 ? [] : ['evidence.sha256 is not a sha256 hex digest']),
    ...(journeys.length ? [] : ['declares no p521Journeys']),
  ];
  return {
    path: input.path,
    evidencePath,
    evidenceSha256,
    journeys,
    decision,
    applied: false,
    reason: problems.length ? `malformed mapping: ${problems.join('; ')}` : 'pending',
  };
}

function observedPeersOf(doc: Record<string, unknown>): string[] {
  const subject = isRecord(doc.subject) ? doc.subject : {};
  const topology = isRecord(subject.topology) ? subject.topology : {};
  const hosts = Array.isArray(topology.hosts) ? topology.hosts : [];
  return uniq(hosts.filter(isRecord).map((h) => h.id).filter((id): id is string => typeof id === 'string' && !!id.trim()));
}

function measuredAtOf(doc: Record<string, unknown>): string | null {
  if (typeof doc.finishedAt === 'string' && Number.isFinite(Date.parse(doc.finishedAt))) return doc.finishedAt;
  const run = isRecord(doc.physicalRun) ? doc.physicalRun : {};
  const window = isRecord(run.window) ? run.window : {};
  if (typeof window.finishedAt === 'string' && Number.isFinite(Date.parse(window.finishedAt))) return window.finishedAt;
  return null;
}

/**
 * The verdict an operational evidence document supports. Pass needs a zero exit AND a
 * positive signal (assertions all passed, or physical legs all `pass`). Any failed
 * assertion/leg or a non-zero exit is a fail. A skipped leg, or no signal at all, is
 * `unknown`: a skipped or unmeasured journey is never a pass.
 */
export function evidenceVerdict(doc: Record<string, unknown>): { verdict: P2pJourneyResult['verdict']; reason: string } {
  const assertions = Array.isArray(doc.assertions) ? doc.assertions.filter(isRecord) : [];
  const run = isRecord(doc.physicalRun) ? doc.physicalRun : {};
  const legs = Array.isArray(run.legVerdicts) ? run.legVerdicts.filter(isRecord) : [];
  const failedAssertions = assertions.filter((a) => a.passed === false).map((a) => String(a.id ?? '?'));
  const failedLegs = legs.filter((l) => l.status === 'fail').map((l) => String(l.leg ?? '?'));
  const skippedLegs = legs.filter((l) => l.status !== 'pass' && l.status !== 'fail').map((l) => `${String(l.leg ?? '?')}:${String(l.status)}`);
  const exitCode = typeof doc.exitCode === 'number' ? doc.exitCode : null;
  if ((exitCode !== null && exitCode !== 0) || failedAssertions.length || failedLegs.length) {
    const parts = [
      ...(exitCode !== null && exitCode !== 0 ? [`exit ${exitCode}`] : []),
      ...(failedAssertions.length ? [`failed assertion(s) ${failedAssertions.join(', ')}`] : []),
      ...(failedLegs.length ? [`failed leg(s) ${failedLegs.join(', ')}`] : []),
    ];
    return { verdict: 'fail', reason: parts.join('; ') };
  }
  if (skippedLegs.length) return { verdict: 'unknown', reason: `leg(s) not run to a verdict: ${skippedLegs.join(', ')}` };
  const positive = assertions.length > 0 ? assertions.every((a) => a.passed === true) : legs.length > 0;
  if (exitCode === 0 && positive) {
    return {
      verdict: 'pass',
      reason: `exit 0; ${assertions.length} assertion(s) passed${legs.length ? `; ${legs.length} physical leg(s) pass` : ''}`,
    };
  }
  return { verdict: 'unknown', reason: exitCode === null ? 'no exit status recorded' : 'no passing assertion or leg recorded' };
}

/** Identity of a foreign artifact set: never equal to a candidate digest by construction of the prefix. */
function foreignDigest(shas: readonly string[]): string {
  return createHash('sha256').update(`foreign:${[...shas].sort().join('\n')}`).digest('hex');
}

export interface DeriveJourneyEvidenceOptions {
  candidate: P2pCandidateProvenance;
  evidence: readonly EvidenceDocInput[];
}

/**
 * Derive P-521 journey results from evidence documents. For each journey the latest
 * candidate-bound document is selected; when none is bound to this candidate the latest
 * declared document on other bytes is selected so the row reads `lineage-mismatch`
 * instead of silently `unmeasured`. Every considered document stays in `bindings`.
 */
export function deriveJourneyEvidence(options: DeriveJourneyEvidenceOptions): DerivedJourneyEvidence {
  const members = new Set(options.candidate.artifacts.map((a) => a.sha256));
  const digest = candidateArtifactDigest(options.candidate.artifacts);
  const known = new Set(P521_JOURNEYS.map((j) => j.key));
  const bindings: JourneyEvidenceBinding[] = [];
  const unmapped: DerivedJourneyEvidence['unmapped'] = [];
  const ignored: DerivedJourneyEvidence['ignored'] = [];

  // Pass 1: journey mappings, indexed by the evidence path they name. Two well-formed
  // mappings for one evidence document is an unresolved acceptance call: neither applies.
  const mappings: JourneyMappingOutcome[] = [];
  const mappingByEvidence = new Map<string, JourneyMappingOutcome[]>();
  for (const input of options.evidence) {
    if (!isRecord(input.doc) || input.doc.kind !== JOURNEY_MAPPING_KIND) continue;
    const mapping = parseJourneyMapping(input, input.doc);
    mappings.push(mapping);
    if (mapping.reason !== 'pending' || !mapping.evidencePath) continue;
    mappingByEvidence.set(mapping.evidencePath, [...(mappingByEvidence.get(mapping.evidencePath) ?? []), mapping]);
  }
  for (const list of mappingByEvidence.values()) {
    if (list.length < 2) continue;
    for (const m of list) m.reason = `more than one mapping names this evidence (${list.map((x) => x.path).join(', ')})`;
  }

  for (const input of options.evidence) {
    const doc = input.doc;
    if (isRecord(doc) && doc.kind === JOURNEY_MAPPING_KIND) continue;
    if (!isRecord(doc) || doc.kind !== 'operational-test-evidence') {
      ignored.push({ path: input.path, reason: 'not an operational-test-evidence document' });
      continue;
    }
    const shas = evidenceArtifactShas(doc);
    if (shas.length === 0) {
      ignored.push({ path: input.path, reason: 'names no artifact sha256 in subject' });
      continue;
    }
    const bound: EvidenceBinding = shas.some((s) => members.has(s)) ? 'this-candidate' : 'other-artifact';
    const inline = declaredJourneys(doc);
    const candidates = (mappingByEvidence.get(input.path) ?? []).filter((m) => m.reason === 'pending');
    const mapping = candidates.length === 1 ? candidates[0] : undefined;
    let journeys = inline;
    let declaredBy = 'inline';
    if (mapping) {
      if (mapping.evidenceSha256 !== input.sha256) {
        mapping.reason = `pinned to evidence sha256 ${mapping.evidenceSha256}, but the document now hashes to ${input.sha256}`;
      } else if (inline && !sameSet(inline, mapping.journeys)) {
        mapping.reason = `contradicts the document's inline declaration (${inline.join(', ')})`;
        ignored.push({
          path: input.path,
          reason: `journey declaration conflict: inline [${inline.join(', ')}] vs ${mapping.path} [${mapping.journeys.join(', ')}]`,
        });
        continue;
      } else {
        mapping.applied = true;
        mapping.reason = inline ? 'agrees with the inline declaration' : 'applied';
        if (!inline) {
          journeys = mapping.journeys;
          declaredBy = mapping.path;
        }
      }
    }
    if (!journeys) {
      if (bound === 'this-candidate') {
        unmapped.push({ path: input.path, sha256: input.sha256, name: typeof doc.name === 'string' ? doc.name : null });
      } else {
        ignored.push({ path: input.path, reason: 'declares no P-521 journey and is not on this candidate' });
      }
      continue;
    }
    // A mapping that applied but whose evidence then proves unusable did not, in the end, apply.
    const withdraw = (why: string) => {
      if (mapping?.applied) {
        mapping.applied = false;
        mapping.reason = why;
      }
    };
    const unknownKeys = journeys.filter((j) => !known.has(j));
    if (unknownKeys.length) {
      const why = `unknown P-521 journey key(s): ${unknownKeys.join(', ')}`;
      withdraw(why);
      ignored.push({ path: input.path, reason: declaredBy === 'inline' ? why : `${why} (declared by ${declaredBy})` });
      continue;
    }
    const measuredAt = measuredAtOf(doc);
    if (!measuredAt) {
      withdraw('the evidence document has no parseable finishedAt');
      ignored.push({ path: input.path, reason: 'no parseable finishedAt' });
      continue;
    }
    const { verdict, reason } = evidenceVerdict(doc);
    bindings.push({
      path: input.path,
      sha256: input.sha256,
      journeys,
      declaredBy,
      binding: bound,
      artifactSha256s: shas,
      verdict,
      reason,
      measuredAt,
      observedPeers: observedPeersOf(doc),
      selected: false,
    });
  }

  const journeys: Record<string, P2pJourneyResult> = {};
  for (const journey of P521_JOURNEYS) {
    const candidates = bindings.filter((b) => b.journeys.includes(journey.key));
    if (candidates.length === 0) continue;
    const latest = (list: JourneyEvidenceBinding[]) =>
      [...list].sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt) || byCodePoint(a.path, b.path))[0];
    const onCandidate = candidates.filter((b) => b.binding === 'this-candidate');
    const chosen = onCandidate.length ? latest(onCandidate) : latest(candidates);
    chosen.selected = true;
    const refs: EvidenceRef[] = [
      {
        ref: chosen.path,
        kind: 'operational-test-evidence',
        detail: { sha256: chosen.sha256, binding: chosen.binding, artifactSha256s: chosen.artifactSha256s },
      },
    ];
    const declaringMapping = mappings.find((m) => m.applied && m.path === chosen.declaredBy);
    if (declaringMapping) {
      refs.push({
        ref: declaringMapping.path,
        kind: JOURNEY_MAPPING_KIND,
        detail: { evidenceSha256: declaringMapping.evidenceSha256, decision: declaringMapping.decision },
      });
    }
    journeys[journey.key] = {
      verdict: chosen.verdict,
      reason: `${chosen.reason} (${chosen.path})`,
      measuredAt: chosen.measuredAt,
      evidence: refs,
      artifactDigest: chosen.binding === 'this-candidate' ? digest : foreignDigest(chosen.artifactSha256s),
      observedPeers: chosen.observedPeers,
    };
  }

  for (const m of mappings) {
    if (m.reason === 'pending') m.reason = 'no evidence document at this path';
  }
  return { journeys, bindings, unmapped, ignored, mappings };
}
