/**
 * pot-git/release-promotion.ts — the SLOW leg of the two-speed gate (Phase 7
 * G-5b, cross-machine-coord-parity-and-trust-2026-07-01 / P-034; D-010/D-011).
 *
 * TWO SPEEDS:
 *   - `staging` (integrator.ts) is the FAST, UNGATED integration — every
 *     admitted member's work merges immediately, the cross-machine analog of
 *     the local autocommit tree. No green gate on the edit/integration hot path.
 *   - `release` (THIS module) is the SLOW, GREEN-GATED promotion: a DISTINCT
 *     ref that advances to a staging sha ONLY when the crefs threshold rule is
 *     satisfied for that exact sha — `threshold` DISTINCT identities from the
 *     rule's `allow` list (e.g. [green-bot, owner], threshold 2) have SIGNED a
 *     green attestation over it.
 *
 * WHERE THE PIECES COME FROM:
 *   - the RULE is Lane A's G-6 canonical-ref rules in the owner-signed hive
 *     policy (hive-policy-schema.ts `HivePolicyCrefsRule`, resolved for the
 *     release ref via `resolveCanonicalRule`). {@link ReleaseRule} is
 *     structurally that resolved shape, kept local so this module has no
 *     policy-store dependency.
 *   - the green-bot ATTESTATION is the distributed test gate's aggregation
 *     verdict (Phase 8 DG-5): green(S) ⇒ the green-bot identity signs S.
 *     {@link GreenAttestation} is that seam — DG-5 produces them, this module
 *     verifies + counts them.
 *
 * FF-ONLY: release advances only along ancestry (the current release must be an
 *   ancestor of the promoted sha). A proof for an OLDER sha can never rewind
 *   release — same invariant class as G-5d/G-7c. Promotion is CAS-guarded so a
 *   concurrent local promoter can't silently clobber.
 *
 * FAIL-CLOSED: unlike the permissive-default policy READS, release promotion
 *   refuses on a malformed/absent rule or proof — a release-class ref must
 *   never advance on a defective gate.
 *
 * Pure over ed25519.ts + storage.ts's RunGit seam; tests run against a real
 * temp bare repo with injected signers.
 */

import { verifyEd25519 } from '../../identity/ed25519';
import { requireHiveEffectAuthority, type HiveEffectAuthority } from './hive-effect-authority';
import { type RunGit, defaultRunGit, readNamespaceRef, writeNamespaceRef } from './storage';

/** The within-namespace ref the integrator publishes the green-gated release at. */
export const RELEASE_REF = 'refs/heads/release';

/**
 * Wire schema version for green attestations.
 *
 * WI-1554: bumped 1 → 2 to add `repo_key` binding (see {@link GreenAttestation}).
 * A v1 attestation (no `repo_key`) now fails {@link isGreenAttestation} — a
 * deliberate FAIL-CLOSED break, not a silent reinterpretation: this module has
 * no live callers yet (the DG-5 aggregator → green-bot signing wire is not
 * built), so there is no v1 wire data anywhere to migrate.
 */
export const GREEN_ATTESTATION_SCHEMA_VERSION = 2;

/** Domain-separation tag for green-attestation signatures (hive-policy idiom). */
export const GREEN_ATTESTATION_SIG_DOMAIN = 'papercusp-pot-git-green-attestation-v1';

/**
 * One identity's signed claim "staging sha S passed the green gate". Produced
 * by the DG-5 aggregator (green-bot) and/or the owner; verified + counted here
 * against the crefs rule.
 */
export interface GreenAttestation {
  /** Wire schema version. */
  v: number;
  /**
   * WI-1554: the managed repo key the attestation covers (G-1b "one gate per
   * (hive, repo)" — the same `repo_key` a DG-1 {@link GateVerdict} binds, and
   * the `repoKey` `hiveGitRepoPath`/`ensurePotGitRepo` resolve a repo's
   * on-disk path from). WITHOUT this, a green(S) attestation carries no
   * repo binding at all: with fork/mirror topologies sharing commit history
   * and one green-bot key in multiple repos' crefs allow lists, an
   * attestation signed for repo A's sha S would satisfy `satisfiesCrefsRule`
   * for repo B's release ref at the same sha, even though B's OWN gate
   * (DG-6 makes suites repo-relative) never ran. `satisfiesCrefsRule` /
   * `promoteRelease` now require this to match the caller's expected repo.
   */
  repo_key: string;
  /** The exact staging sha the attestation covers. */
  staging_sha: string;
  /** The attesting identity's raw-32 Ed25519 pubkey (base64) — must be in `allow`. */
  signer_pubkey: string;
  /** Attestation time (epoch ms) — audit only. */
  ts: number;
  /** base64 Ed25519 signature over greenAttestationSigningBytes(payload). */
  sig: string;
}

/**
 * The resolved promotion rule for the release ref — structurally identical to
 * hive-policy-schema's `ResolvedCanonicalRule` / a valid `HivePolicyCrefsRule`
 * (G-6 P-030): `threshold` DISTINCT keys from `allow` must have signed.
 */
export interface ReleaseRule {
  /** Identity pubkeys (base64) whose signatures count toward the threshold. */
  allow: string[];
  /** How many DISTINCT `allow` keys must have signed (≥ 1). */
  threshold: number;
}

const SHA_RE = /^[0-9a-f]{40,64}$/;

function isGreenAttestation(x: unknown): x is GreenAttestation {
  if (!x || typeof x !== 'object') return false;
  const a = x as Record<string, unknown>;
  return (
    typeof a.v === 'number' &&
    typeof a.repo_key === 'string' &&
    a.repo_key.length > 0 &&
    typeof a.staging_sha === 'string' &&
    SHA_RE.test(a.staging_sha) &&
    typeof a.signer_pubkey === 'string' &&
    typeof a.ts === 'number' &&
    typeof a.sig === 'string'
  );
}

/** Canonical signing bytes: domain tag + fixed field order (`sig` excluded). */
export function greenAttestationSigningBytes(payload: Omit<GreenAttestation, 'sig'>): Buffer {
  const ordered = {
    v: payload.v,
    repo_key: payload.repo_key,
    staging_sha: payload.staging_sha,
    signer_pubkey: payload.signer_pubkey,
    ts: payload.ts,
  };
  return Buffer.from(`${GREEN_ATTESTATION_SIG_DOMAIN}\n${JSON.stringify(ordered)}`, 'utf8');
}

/** Build + sign a green attestation (the DG-5 aggregator / owner side). */
export async function signGreenAttestation(
  fields: { repoKey: string; stagingSha: string; signerPubkeyBase64: string; nowMs: number },
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<GreenAttestation> {
  const payload = {
    v: GREEN_ATTESTATION_SCHEMA_VERSION,
    repo_key: fields.repoKey,
    staging_sha: fields.stagingSha,
    signer_pubkey: fields.signerPubkeyBase64,
    ts: fields.nowMs,
  };
  const sig = (await sign(greenAttestationSigningBytes(payload))).toString('base64');
  return { ...payload, sig };
}

/** Verify one attestation's signature against its embedded signer. Never throws. */
export function verifyGreenAttestation(att: GreenAttestation): boolean {
  if (!isGreenAttestation(att)) return false;
  try {
    return verifyEd25519(greenAttestationSigningBytes(att), att.signer_pubkey, Buffer.from(att.sig, 'base64'));
  } catch {
    return false;
  }
}

export interface CrefsRuleVerdict {
  ok: boolean;
  /** The DISTINCT allow-listed signers whose attestations verified over the sha. */
  validSigners: string[];
  /** Set when `ok` is false. */
  reason?: 'malformed-rule' | 'threshold-not-met';
}

/**
 * Does `proof` satisfy `rule` for `stagingSha` at `repoKey`? Counts DISTINCT
 * signers that are (a) in the rule's allow list and (b) have a VALID
 * signature over exactly this sha AND this repo_key. Duplicate attestations
 * by one signer count once; attestations for other shas, OTHER REPOS
 * (WI-1554 — a green(S) attestation minted for a DIFFERENT repo sharing
 * commit history and the same allow-listed signer must never satisfy this
 * repo's rule), unknown signers, or with bad signatures are ignored.
 * FAIL-CLOSED on a malformed rule.
 */
export function satisfiesCrefsRule(
  stagingSha: string,
  repoKey: string,
  proof: readonly GreenAttestation[],
  rule: ReleaseRule,
): CrefsRuleVerdict {
  if (
    !rule ||
    !Array.isArray(rule.allow) ||
    rule.allow.length === 0 ||
    !Number.isInteger(rule.threshold) ||
    rule.threshold < 1
  ) {
    return { ok: false, validSigners: [], reason: 'malformed-rule' };
  }
  const allow = new Set(rule.allow);
  const valid = new Set<string>();
  for (const att of proof) {
    if (!isGreenAttestation(att)) continue;
    if (att.staging_sha !== stagingSha) continue;
    if (att.repo_key !== repoKey) continue; // WI-1554: cross-repo replay guard
    if (!allow.has(att.signer_pubkey)) continue;
    if (valid.has(att.signer_pubkey)) continue; // distinct signers only
    if (!verifyGreenAttestation(att)) continue;
    valid.add(att.signer_pubkey);
  }
  if (valid.size < rule.threshold) {
    return { ok: false, validSigners: [...valid].sort(), reason: 'threshold-not-met' };
  }
  return { ok: true, validSigners: [...valid].sort() };
}

export type PromoteReleaseResult =
  | { promoted: true; release: string; validSigners: string[] }
  | {
      promoted: false;
      /** The (unchanged) current release sha, null when none exists. */
      release: string | null;
      reason: 'malformed-rule' | 'threshold-not-met' | 'unknown-sha' | 'non-fast-forward' | 'already-current' | 'missing-hive-authority';
      validSigners?: string[];
    };

/** The all-zeros old-value that makes `update-ref <ref> <new> <old>` a create-only CAS. */
const ZERO_SHA = '0'.repeat(40);

/**
 * Promote `stagingSha` to the integrator's release ref
 * (`refs/namespaces/<integratorHex>/refs/heads/release`) IFF the green proof
 * satisfies the crefs rule for `repoKey` — the G-5b slow gate. FF-only: the
 * current release (when one exists) must be an ancestor of the promoted sha;
 * the write is CAS-guarded against the read. Never advances on a defective
 * rule/proof. `repoKey` (WI-1554) is the caller's OWN repo identity (the same
 * `repoKey` used to resolve `repoPath` via `hiveGitRepoPath`) — an attestation
 * minted for a different repo can never promote this one, even at the same sha.
 */
export async function promoteRelease(
  repoPath: string,
  integratorDevicePubkeyBase64: string,
  repoKey: string,
  stagingSha: string,
  greenProof: readonly GreenAttestation[],
  rule: ReleaseRule,
  opts: { runGit?: RunGit; hiveId?: string; authority?: HiveEffectAuthority | null } = {},
): Promise<PromoteReleaseResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  const current = await readNamespaceRef(repoPath, integratorDevicePubkeyBase64, RELEASE_REF, runGit);

  const verdict = satisfiesCrefsRule(stagingSha, repoKey, greenProof, rule);
  if (!verdict.ok) {
    return { promoted: false, release: current, reason: verdict.reason!, validSigners: verdict.validSigners };
  }

  // The sha must be a commit we actually have (fetch/integration precedes promotion).
  const exists = await runGit(['rev-parse', '--verify', '-q', `${stagingSha}^{commit}`], repoPath);
  if (exists.code !== 0) return { promoted: false, release: current, reason: 'unknown-sha' };

  if (current === stagingSha) {
    return { promoted: false, release: current, reason: 'already-current', validSigners: verdict.validSigners };
  }
  if (current !== null) {
    const ff = await runGit(['merge-base', '--is-ancestor', current, stagingSha], repoPath);
    if (ff.code !== 0) return { promoted: false, release: current, reason: 'non-fast-forward' };
  }

  // CAS against what we read — a concurrent promoter loses cleanly (update-ref
  // exits nonzero) instead of silently clobbering.
  try {
    await requireHiveEffectAuthority(opts.authority, { hive_id: opts.hiveId ?? '', repo_key: repoKey },
      ['promote-release', repoPath, integratorDevicePubkeyBase64, stagingSha]);
  } catch {
    return { promoted: false, release: current, reason: 'missing-hive-authority' };
  }
  await writeNamespaceRef(
    repoPath,
    integratorDevicePubkeyBase64,
    RELEASE_REF,
    stagingSha,
    runGit,
    current ?? ZERO_SHA,
  );
  return { promoted: true, release: stagingSha, validSigners: verdict.validSigners };
}

/** Read the integrator's currently-published release sha (null if none). */
export function readRelease(
  repoPath: string,
  integratorDevicePubkeyBase64: string,
  runGit: RunGit = defaultRunGit,
): Promise<string | null> {
  return readNamespaceRef(repoPath, integratorDevicePubkeyBase64, RELEASE_REF, runGit);
}
