/**
 * Full replayable evidence preservation and content-addressed sealing (plan
 * `llm-agent-evaluation-measurement-integrity-2026-08-25`, item P-005).
 *
 * ## What P-004 left and what this fills
 *
 * `EvidenceEnvelope` (schema.ts) fixes the SLOTS a trial's evidence occupies —
 * `trajectoryRef`, `submissionRef`, `rawGraderOutputRef`, `artifactRefs`,
 * `privacy`, `contentHash` — and deliberately stores only REFS, so an envelope
 * stays small enough to carry beside a verdict without dragging a transcript with
 * it. It says nothing about what those refs point AT, and nothing binds the bytes
 * they resolve to back to the trial that was graded from them.
 *
 * This module supplies the missing half: a structured model of the preserved
 * evidence itself, and a SEAL over it whose root hash is the value that belongs in
 * `EvidenceEnvelope.contentHash`.
 *
 * ## Why order is part of the evidence
 *
 * A trajectory is an ORDERED sequence. Two runs that issued the same tool calls in
 * a different order did not do the same thing — one may have read a file before
 * writing it and the other after. So `sealEvidence` hashes trajectory steps in
 * their given order and never sorts them, while artifacts (a keyed SET, where
 * enumeration order carries no meaning) are sorted by id so an incidental
 * enumeration difference cannot move the hash.
 *
 * Getting that backwards in either direction is a real failure mode, so both
 * halves carry a permanent wrong-implementation control in
 * `evidence-integrity.test.ts`: a naive seal that sorts the trajectory is asserted
 * to COLLIDE on two genuinely different runs exactly where this one splits.
 *
 * ## `undefined` and `null` seal differently, by construction
 *
 * D-021 governs this module as it governs the adapters: `undefined` means the
 * source does not record the fact, `null` means the source records it as
 * genuinely absent. Every fixed slot below is hashed on EVERY seal, as
 * `NOT_RECORDED` (`?`) or `RECORDED_ABSENT` (`~`) when empty — the tokens are
 * imported from identity.ts rather than redeclared, so the evidence seal and the
 * trial binding can never disagree about what "empty" means.
 *
 * The consequence that matters: an evidence set which never recorded a submission
 * seals to a different root than one which recorded that there was no submission.
 * A verifier can therefore tell "we do not know" from "we know there was none",
 * which is precisely the distinction an integrity check exists to preserve.
 *
 * @see integrity.ts   — verification over a manifest (corruption, missing, mismatch)
 * @see judge-view.ts  — the compact view DERIVED from this evidence
 * @see portable.ts    — the Inspect / OpenTelemetry projections
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from '../external-bench/reproducibility/canonical-json';
import { NOT_RECORDED, RECORDED_ABSENT, canonicalToken } from './identity';
import type { EvidenceEnvelope, PrivacyClass } from './schema';

/** Domain-separation tag hashed into every evidence seal. */
export const EVIDENCE_SEAL_DOMAIN = 'papercusp-evaluation-evidence-seal-v1';

/** What one step of a trajectory represents. */
export type TrajectoryStepKind =
  | 'input'
  | 'model-output'
  | 'tool-call'
  | 'tool-result'
  | 'note';

/**
 * One ordered step of a replayable trajectory.
 *
 * `index` is carried explicitly rather than inferred from array position so that a
 * trajectory which was persisted, filtered, or paged still states its own ordering
 * — a step list missing its middle is then detectable, instead of silently
 * re-indexing into a plausible-looking shorter run.
 */
export interface TrajectoryStep {
  /** 0-based ordinal within the full trajectory. Part of the seal. */
  index: number;
  kind: TrajectoryStepKind;
  /** ISO timestamp, when the source records one. */
  at?: string | null;
  /** Speaker/actor for conversational steps (`user`, `assistant`, an agent id). */
  role?: string | null;
  /** Tool name for `tool-call` / `tool-result` steps. */
  name?: string | null;
  /** The step payload, VERBATIM. Never normalized — normalization is a judge view's job. */
  content: string;
  /** Arm-specific detail, opaque to sealing beyond its canonical hash. */
  metadata?: Record<string, unknown> | null;
}

/**
 * The environment a trial ran in.
 *
 * `TrialSystemIdentity.environmentFingerprint` stores a HASH of this for identity
 * (cheap to compare); this is the blob that hash is taken over, preserved so a
 * third party can inspect what actually differed when two fingerprints disagree.
 */
export interface EnvironmentSnapshot {
  os?: string | null;
  /** Runtime version string (node, python, …). */
  runtime?: string | null;
  /** Container/image digests keyed by role (`harness`, `grader`, …). */
  imageDigests?: Record<string, string> | null;
  gitSha?: string | null;
  /** Captured environment variables. Callers redact BEFORE preserving. */
  env?: Record<string, string> | null;
  /** Anything else the family records; hashed canonically. */
  raw?: Record<string, unknown> | null;
}

/**
 * One preserved artifact.
 *
 * The bytes themselves are NOT held here — `ref` says where they live, exactly as
 * the envelope's refs do. What is held is the `sha256` the bytes must hash to,
 * which is what makes "the artifact is missing" and "the artifact was swapped"
 * two distinguishable findings rather than one vague failure.
 */
export interface PreservedArtifact {
  /** Stable id within the trial (a path, a name, an ordinal). */
  id: string;
  mediaType: string;
  /** Byte length of the artifact content. */
  bytes: number;
  /** sha256 of the artifact content, lowercase hex. */
  sha256: string;
  /** Where the content lives. `null` = recorded as inline/no external location. */
  ref?: string | null;
}

/** The complete replayable evidence for one trial. */
export interface PreservedEvidence {
  /** ORDERED. Never sorted by the seal. */
  trajectory: TrajectoryStep[];
  environment?: EnvironmentSnapshot | null;
  /** A keyed SET — sealed in id order, so enumeration order is not significant. */
  artifacts: PreservedArtifact[];
  /** The exact graded submission (a unified diff, an env handle, an answer). */
  submission?: string | null;
  /** The benchmark's own grader output, VERBATIM. */
  rawGraderOutput?: string | null;
  privacy: PrivacyClass;
}

/** One sealed component of an evidence set. */
export interface EvidencePart {
  /**
   * Stable part id: `trajectory`, `environment`, `submission`,
   * `raw-grader-output`, or `artifact:<id>`.
   */
  id: string;
  /** sha256 over the part's canonical encoding, lowercase hex. */
  sha256: string;
  /**
   * Byte length of what was sealed — the artifact's own size for artifacts, the
   * canonical encoding's length for everything else. A part whose hash matches but
   * whose length disagrees is a hash-function problem, not a content problem, so
   * the two are reported separately.
   */
  bytes: number;
}

/**
 * The manifest of a sealed evidence set.
 *
 * This is the durable companion to an `EvidenceEnvelope`: the envelope carries the
 * root hash beside the verdict, the manifest carries the per-part detail needed to
 * say WHICH part failed when the root does not match.
 */
export interface EvidenceManifest {
  domain: string;
  /**
   * Every part that carries content, in canonical order. A slot the source left
   * empty is absent here but is still hashed into `rootHash` as its empty token,
   * so "no submission recorded" and "submission recorded as none" produce
   * different roots while producing the same (empty) part list.
   */
  parts: EvidencePart[];
  /** sha256 over the domain tag and every canonical line. Belongs in `EvidenceEnvelope.contentHash`. */
  rootHash: string;
  /** Ordered trajectory length, so a truncated replay is detectable from the manifest alone. */
  stepCount: number;
  /** Highest `index` seen, so a trajectory with a HOLE is detectable too. */
  maxStepIndex: number | null;
  privacy: PrivacyClass;
}

/** A sealed evidence set: the manifest, plus the envelope fields the seal determines. */
export interface SealedEvidence {
  manifest: EvidenceManifest;
  /**
   * The envelope fields sealing establishes — `contentHash`, `privacy`, and the
   * artifact refs. The identity-bearing refs (`trajectoryRef`, `submissionRef`,
   * `rawGraderOutputRef`) stay the caller's to set: only the source surface knows
   * where it persisted them, and inventing a ref here would be exactly the
   * "adapters never invent" violation D-021 forbids.
   */
  envelope: Pick<EvidenceEnvelope, 'contentHash' | 'privacy' | 'artifactRefs'>;
}

/** sha256 of a UTF-8 string, lowercase hex. */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Canonical token for an optional blob: the empty tokens when empty, otherwise a
 * hash of its canonical JSON. Hashing rather than inlining keeps every canonical
 * line bounded regardless of how large the underlying value is.
 */
function blobToken(value: unknown): string {
  if (value === undefined) return NOT_RECORDED;
  if (value === null) return RECORDED_ABSENT;
  return sha256(canonicalJson(value));
}

/** Canonical token for an optional string: empty tokens when empty, else its hash. */
function textToken(value: string | null | undefined): string {
  if (value === undefined) return NOT_RECORDED;
  if (value === null) return RECORDED_ABSENT;
  return sha256(value);
}

/**
 * The canonical encoding of one trajectory step.
 *
 * `index` is hashed as a field, so re-ordering the array changes both the position
 * a step is hashed at AND the value hashed there. A seal that only hashed position
 * would be defeated by a source that renumbered; one that only hashed `index`
 * would be defeated by a reorder. Hashing both means either alone is enough to
 * split, which is the direction an unknown must fail in.
 */
function sealStep(step: TrajectoryStep): string {
  const lines = [
    `${EVIDENCE_SEAL_DOMAIN}/step`,
    `index=${canonicalToken(step.index)}`,
    `kind=${canonicalToken(step.kind)}`,
    `at=${canonicalToken(step.at)}`,
    `role=${canonicalToken(step.role)}`,
    `name=${canonicalToken(step.name)}`,
    `content=${sha256(step.content)}`,
    `metadata=${blobToken(step.metadata)}`,
  ];
  return sha256(lines.join('\n'));
}

/** The canonical encoding of one artifact's identity. */
function sealArtifact(artifact: PreservedArtifact): string {
  const lines = [
    `${EVIDENCE_SEAL_DOMAIN}/artifact`,
    `id=${canonicalToken(artifact.id)}`,
    `mediaType=${canonicalToken(artifact.mediaType)}`,
    `bytes=${canonicalToken(artifact.bytes)}`,
    `sha256=${canonicalToken(artifact.sha256)}`,
    `ref=${canonicalToken(artifact.ref)}`,
  ];
  return sha256(lines.join('\n'));
}

/**
 * Seal an evidence set: compute every part hash and the root that binds them.
 *
 * Pure and deterministic. Identical evidence always seals identically, regardless
 * of how either object was constructed — the field list and the ordering rules are
 * fixed here, not inherited from whatever order an object literal happened to be
 * built in.
 */
export function sealEvidence(evidence: PreservedEvidence): SealedEvidence {
  const parts: EvidencePart[] = [];
  const lines: string[] = [
    EVIDENCE_SEAL_DOMAIN,
    `privacy=${canonicalToken(evidence.privacy)}`,
    `stepCount=${evidence.trajectory.length}`,
  ];

  // ORDER IS EVIDENCE — never sorted.
  const stepHashes: string[] = [];
  for (const step of evidence.trajectory) {
    const hash = sealStep(step);
    stepHashes.push(hash);
    lines.push(`step.${stepHashes.length - 1}=${hash}`);
  }
  if (stepHashes.length > 0) {
    parts.push({
      id: 'trajectory',
      sha256: sha256(`${EVIDENCE_SEAL_DOMAIN}/trajectory\n${stepHashes.join('\n')}`),
      bytes: evidence.trajectory.reduce((sum, s) => sum + Buffer.byteLength(s.content, 'utf8'), 0),
    });
  }

  const environmentToken = blobToken(evidence.environment);
  lines.push(`environment=${environmentToken}`);
  if (evidence.environment !== undefined && evidence.environment !== null) {
    const encoded = canonicalJson(evidence.environment);
    parts.push({ id: 'environment', sha256: environmentToken, bytes: Buffer.byteLength(encoded, 'utf8') });
  }

  const submissionToken = textToken(evidence.submission);
  lines.push(`submission=${submissionToken}`);
  if (evidence.submission !== undefined && evidence.submission !== null) {
    parts.push({
      id: 'submission',
      sha256: submissionToken,
      bytes: Buffer.byteLength(evidence.submission, 'utf8'),
    });
  }

  const graderToken = textToken(evidence.rawGraderOutput);
  lines.push(`rawGraderOutput=${graderToken}`);
  if (evidence.rawGraderOutput !== undefined && evidence.rawGraderOutput !== null) {
    parts.push({
      id: 'raw-grader-output',
      sha256: graderToken,
      bytes: Buffer.byteLength(evidence.rawGraderOutput, 'utf8'),
    });
  }

  // A keyed SET — sorted by id, because enumeration order carries no meaning here.
  const sortedArtifacts = [...evidence.artifacts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const artifactRefs: string[] = [];
  for (const artifact of sortedArtifacts) {
    const hash = sealArtifact(artifact);
    lines.push(`artifact.${artifact.id}=${hash}`);
    parts.push({ id: `artifact:${artifact.id}`, sha256: hash, bytes: artifact.bytes });
    if (artifact.ref !== undefined && artifact.ref !== null) artifactRefs.push(artifact.ref);
  }

  const rootHash = sha256(lines.join('\n'));
  const maxStepIndex = evidence.trajectory.length === 0
    ? null
    : evidence.trajectory.reduce((max, s) => (s.index > max ? s.index : max), evidence.trajectory[0].index);

  return {
    manifest: {
      domain: EVIDENCE_SEAL_DOMAIN,
      parts,
      rootHash,
      stepCount: evidence.trajectory.length,
      maxStepIndex,
      privacy: evidence.privacy,
    },
    envelope: {
      contentHash: rootHash,
      privacy: evidence.privacy,
      artifactRefs,
    },
  };
}
