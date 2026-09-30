/**
 * pot-git/sigrefs.ts — device-signed ref snapshots (Phase 7 G-4/G-4b,
 * cross-machine-coord-parity-and-trust-2026-07-01 / P-028, P-039; D-010/D-011).
 *
 * The Radicle `refs/rad/sigrefs` model, adapted. A device periodically signs a
 * canonical snapshot of ITS OWN namespace's ref-set (each ref name → the sha it
 * points at) and stores it as a git BLOB referenced at `refs/rad/sigrefs` INSIDE
 * that namespace (`refs/namespaces/<devHex>/refs/rad/sigrefs`). Because it lives
 * under the namespace, G-2's `refs/namespaces/<devHex>/*` fetch carries it along
 * with the heads.
 *
 * WHY (the transitive-relay tamper hole): a receiver may fetch device B's
 * namespace THROUGH a relay peer C (C mirrored B, A fetches from C). C could
 * advance B's namespace heads to shas B never published. The sigrefs blob is
 * signed by B's device key over the exact (ref → sha) set, so A verifies B
 * actually published those heads before trusting them — C can relay but cannot
 * forge. Membership already device-gates WHO can be in the hive; sigrefs gates
 * WHAT a fetched namespace's heads are, independent of the relay path.
 *
 * G-4b (rollback / TUF class): the snapshot carries a monotonic `version`. A
 * receiver rejects a fetched sigrefs whose version is ≤ the one it already
 * accepted for that device — so a relay cannot roll a namespace back to a stale
 * (but validly-signed) earlier state. The watermark is simply the version of the
 * sigrefs CURRENTLY stored in the local mirror for that device (no side table):
 * accept iff `incoming.version > stored.version`.
 *
 * Pure over storage.ts's RunGit seam + ed25519.ts's key helpers, so the whole
 * module unit-tests against a real temp bare repo with an injected signer.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEd25519 } from '../../identity/ed25519';
import {
  type RunGit,
  defaultRunGit,
  deviceNamespaceKey,
  listNamespaceRefs,
  readNamespaceRef,
  writeNamespaceRef,
} from './storage';
import {
  SIGNED_PROTOCOL_SCHEMA_VERSION,
  isSignedProtocolContext,
  signedProtocolContextMatches,
  compareGenerationVersion,
  type ExpectedSignedProtocolContext,
  type SignedSnapshotFloor,
  type SignedProtocolContext,
} from './signed-context';

/** The within-namespace ref that holds the signed snapshot blob. */
export const SIGREFS_REF = 'refs/rad/sigrefs';

/** Sigrefs schema version (the wire shape, distinct from the monotonic
 *  per-device `version` counter used for rollback protection). */
export const SIGREFS_SCHEMA_VERSION = 1;
/** Context-bound hive-wide sigrefs version. */
// Scope-repo origin claims already occupy wire version 2. Keep that legacy
// shape intact and use v3 for the context-bound hive-wide snapshot.
export const SIGREFS_SCHEMA_VERSION_CONTEXT = SIGNED_PROTOCOL_SCHEMA_VERSION + 1;

/**
 * v2 — SCOPE-REPO sigrefs only (P-109 leg iii / C8, ratified D-017 n2 +
 * D-018 RC-3): entries MAY carry an `originClaim`, the executor's statement
 * "I signed this ref AS EXECUTOR; its AUTHOR is the named origin". The bump
 * is CONFINED to per-scope repos: the hive-wide sigref plane stays v1 and
 * `acceptFetchedSigrefs` REFUSES claim-bearing payloads unless the caller
 * (a scope-repo integrator) explicitly opts in — the C5 fail-closed posture
 * for version skew, applied within scope participants.
 */
export const SIGREFS_SCHEMA_VERSION_SCOPE = 2;

/** The C8 executor-not-author statement attached to a scope-repo ref. */
export interface SigrefOriginClaim {
  /** M21 thread key. */
  offer_id: string;
  /** The AUTHOR's GitHub numeric user id (X9 — never a login). */
  origin_github_user_id: number;
  /** H9 fencing epoch the executor ran under. */
  execution_epoch: number;
}

/** One (ref → sha) entry of a device's namespace snapshot. */
export interface SigrefEntry {
  /** A within-namespace ref, e.g. `refs/heads/work` (NEVER the sigrefs ref). */
  ref: string;
  sha: string;
  /** SCOPE-REPO ONLY (v2): the executor's origin claim for a foreign result
   *  ref. Absent everywhere on the hive-wide plane (D-017 n2 confinement). */
  originClaim?: SigrefOriginClaim;
}

/** The signed payload — canonical over a fixed field order + sorted refs. */
export interface SigrefsPayload {
  /** Wire schema version. */
  v: number;
  /** The signing device's raw-32 Ed25519 pubkey (base64) — bound into the sig. */
  device_pubkey: string;
  /** Monotonic per-device counter (G-4b rollback watermark). */
  version: number;
  /** Snapshot time (epoch ms) — audit/freshness. */
  ts: number;
  /** The device's ref-set, sorted by ref name (excludes the sigrefs ref). */
  refs: SigrefEntry[];
  /** V2 stable signed identity tuple. Absent on legacy v1 snapshots. */
  hive_id?: string;
  repo_key?: string;
  store_generation?: string;
}

export interface SignedSigrefs extends SigrefsPayload {
  /** base64 Ed25519 signature over sigrefsSigningBytes(payload). */
  sig: string;
}

/**
 * Canonical signing bytes: fixed field order + refs pre-sorted by name (the
 * hive-announce idiom). Deterministic for a given ref-set, so both ends compute
 * identical bytes. `sig` is excluded (it signs everything else).
 */
export function sigrefsSigningBytes(payload: SigrefsPayload): Buffer {
  const ordered: Record<string, unknown> = {
    v: payload.v,
    device_pubkey: payload.device_pubkey,
    version: payload.version,
    ts: payload.ts,
    refs: [...payload.refs]
      .sort((a, b) => a.ref.localeCompare(b.ref))
      // originClaim (v2, scope repos) is part of the signed statement when
      // present — a relay must not be able to strip or alter WHO authored a
      // result without breaking the executor's signature.
      .map((r) =>
        r.originClaim
          ? {
              ref: r.ref,
              sha: r.sha,
              originClaim: {
                offer_id: r.originClaim.offer_id,
                origin_github_user_id: r.originClaim.origin_github_user_id,
                execution_epoch: r.originClaim.execution_epoch,
              },
            }
          : { ref: r.ref, sha: r.sha },
      ),
  };
  if (payload.v === SIGREFS_SCHEMA_VERSION_CONTEXT) {
    ordered.hive_id = payload.hive_id;
    ordered.repo_key = payload.repo_key;
    ordered.store_generation = payload.store_generation;
  }
  const domain = payload.v === SIGREFS_SCHEMA_VERSION_CONTEXT ? 'papercusp-pot-git-sigrefs-v3\n' : '';
  return Buffer.from(domain + JSON.stringify(ordered), 'utf8');
}

/** hash-object a UTF-8 blob into `repoPath`'s ODB (via a temp file, so the
 *  stdin-free RunGit seam still works) → the blob sha. */
export async function hashBlob(repoPath: string, content: string, runGit: RunGit): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sigrefs-'));
  try {
    const f = join(dir, 'blob');
    await writeFile(f, content, 'utf8');
    const r = await runGit(['hash-object', '-w', '-t', 'blob', f], repoPath);
    if (r.code !== 0) throw new Error(`sigrefs: hash-object failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Read + parse the sigrefs blob currently stored for a device in `repoPath`
 * (null if none, or if it's malformed). Used both to read a peer's fetched
 * sigrefs and to compute the local rollback watermark.
 */
export async function readSigrefs(
  repoPath: string,
  devicePubkeyBase64: string,
  runGit: RunGit = defaultRunGit,
): Promise<SignedSigrefs | null> {
  const blobSha = await readNamespaceRef(repoPath, devicePubkeyBase64, SIGREFS_REF, runGit);
  if (!blobSha) return null;
  const r = await runGit(['cat-file', 'blob', blobSha], repoPath);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as SignedSigrefs;
    if (!isSignedSigrefs(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSignedSigrefs(x: unknown): x is SignedSigrefs {
  if (!x || typeof x !== 'object') return false;
  const s = x as Record<string, unknown>;
  const baseOk = (
    typeof s.v === 'number' &&
    typeof s.device_pubkey === 'string' &&
    typeof s.version === 'number' &&
    Number.isSafeInteger(s.version) && s.version >= 0 &&
    typeof s.ts === 'number' &&
    Array.isArray(s.refs) &&
    s.refs.every((e) => {
      if (!e || typeof e !== 'object') return false;
      const entry = e as SigrefEntry;
      if (typeof entry.ref !== 'string' || typeof entry.sha !== 'string') return false;
      if (entry.originClaim === undefined) return true;
      const c = entry.originClaim as unknown as Record<string, unknown>;
      return (
        !!c &&
        typeof c === 'object' &&
        typeof c.offer_id === 'string' &&
        typeof c.origin_github_user_id === 'number' &&
        Number.isSafeInteger(c.origin_github_user_id) &&
        typeof c.execution_epoch === 'number'
      );
    }) &&
    typeof s.sig === 'string' &&
    (s.v === SIGREFS_SCHEMA_VERSION || s.v === SIGREFS_SCHEMA_VERSION_CONTEXT || s.v === SIGREFS_SCHEMA_VERSION_SCOPE)
  );
  if (!baseOk) return false;
  return s.v !== SIGREFS_SCHEMA_VERSION_CONTEXT || isSignedProtocolContext(s);
}

/**
 * Build + STORE this device's sigrefs snapshot: read its namespace ref-set
 * (excluding the sigrefs ref itself), sign it, write the blob, point
 * `refs/rad/sigrefs` at it. `version` auto-increments off the currently-stored
 * snapshot unless overridden. Returns the signed snapshot. `sign` is the device
 * signer seam (prod: `bytes => signWithDeviceKey(keychainId, bytes)`).
 */
export async function buildSigrefs(
  repoPath: string,
  devicePubkeyBase64: string,
  sign: (bytes: Buffer) => Promise<Buffer>,
  opts: { nowMs: number; version?: number; versionFloor?: number; runGit?: RunGit; context?: SignedProtocolContext } = { nowMs: 0 },
): Promise<SignedSigrefs> {
  const runGit = opts.runGit ?? defaultRunGit;
  const all = await listNamespaceRefs(repoPath, devicePubkeyBase64, runGit);
  const refs: SigrefEntry[] = all
    .filter((r) => r.ref !== SIGREFS_REF)
    .map((r) => ({ ref: r.ref, sha: r.sha }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
  let version = opts.version;
  if (version === undefined) {
    const prior = await readSigrefs(repoPath, devicePubkeyBase64, runGit);
    if (
      opts.versionFloor !== undefined &&
      (!Number.isSafeInteger(opts.versionFloor) || opts.versionFloor < 0)
    ) {
      throw new Error('sigrefs: versionFloor must be a non-negative safe integer');
    }
    // A cold join may legitimately rebuild the bare store while retaining the
    // same device identity. The store-local sigrefs ref then disappears, but a
    // peer can still hold a later version and will (correctly) reject a reset to
    // v1 as rollback. The runtime persists the last locally-published version in
    // the existing git-sync routine metadata and supplies it as this floor.
    const sameGeneration = !opts.context || signedProtocolContextMatches(prior, opts.context);
    version = Math.max(sameGeneration ? prior?.version ?? 0 : 0, opts.versionFloor ?? 0) + 1;
  }
  if (!Number.isSafeInteger(version) || version < 0 || (opts.context && !isSignedProtocolContext(opts.context))) {
    throw new Error('sigrefs: invalid signed context or sequence');
  }
  const payload: SigrefsPayload = {
    v: opts.context ? SIGREFS_SCHEMA_VERSION_CONTEXT : SIGREFS_SCHEMA_VERSION,
    device_pubkey: devicePubkeyBase64,
    version,
    ts: opts.nowMs,
    refs,
    ...(opts.context ?? {}),
  };
  const sig = (await sign(sigrefsSigningBytes(payload))).toString('base64');
  const signed: SignedSigrefs = { ...payload, sig };
  const blobSha = await hashBlob(repoPath, JSON.stringify(signed), runGit);
  // The sigrefs ref points at the blob (a ref may reference any object type).
  await writeNamespaceRef(repoPath, devicePubkeyBase64, SIGREFS_REF, blobSha, runGit);
  return signed;
}

/**
 * Build + STORE the executor's SCOPE-REPO sigrefs (P-109 leg iii, C8/RC-3):
 * signs the scope repo's TOP-LEVEL `refs/foreign/*` result refs (the RC-4
 * in-repo marker family — scope repos publish results top-level, not
 * namespace-nested), attaching each ref's `originClaim` from `claims`. The
 * payload is v2 iff any claim attaches (D-017 n2: the bump is confined to
 * scope repos; a claim-less snapshot stays v1). Stored at the executor
 * device's namespace SIGREFS_REF like every sigrefs snapshot, so the
 * per-device read/verify/rollback machinery applies unchanged.
 */
export async function buildScopeSigrefs(
  scopeRepoPath: string,
  executorDevicePubkeyBase64: string,
  sign: (bytes: Buffer) => Promise<Buffer>,
  opts: {
    nowMs: number;
    /** ref → the executor's origin claim for that result ref. */
    claims?: Map<string, SigrefOriginClaim>;
    version?: number;
    runGit?: RunGit;
    context?: SignedProtocolContext;
  },
): Promise<SignedSigrefs> {
  const runGit = opts.runGit ?? defaultRunGit;
  const list = await runGit(
    ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/foreign/'],
    scopeRepoPath,
  );
  if (list.code !== 0) throw new Error(`scope sigrefs: for-each-ref failed: ${list.stderr.trim()}`);
  const claims = opts.claims ?? new Map<string, SigrefOriginClaim>();
  const refs: SigrefEntry[] = list.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const sp = l.indexOf(' ');
      const ref = l.slice(0, sp);
      const sha = l.slice(sp + 1);
      const claim = claims.get(ref);
      return claim ? { ref, sha, originClaim: claim } : { ref, sha };
    })
    .sort((a, b) => a.ref.localeCompare(b.ref));
  let version = opts.version;
  if (version === undefined) {
    const prior = await readSigrefs(scopeRepoPath, executorDevicePubkeyBase64, runGit);
    version = (prior?.version ?? 0) + 1;
  }
  const carriesClaims = refs.some((r) => r.originClaim !== undefined);
  const payload: SigrefsPayload = {
    v: opts.context ? SIGREFS_SCHEMA_VERSION_CONTEXT : carriesClaims ? SIGREFS_SCHEMA_VERSION_SCOPE : SIGREFS_SCHEMA_VERSION,
    device_pubkey: executorDevicePubkeyBase64,
    version,
    ts: opts.nowMs,
    refs,
    ...(opts.context ?? {}),
  };
  const sig = (await sign(sigrefsSigningBytes(payload))).toString('base64');
  const signed: SignedSigrefs = { ...payload, sig };
  const blobSha = await hashBlob(scopeRepoPath, JSON.stringify(signed), runGit);
  await writeNamespaceRef(scopeRepoPath, executorDevicePubkeyBase64, SIGREFS_REF, blobSha, runGit);
  return signed;
}

/**
 * Verify a signed sigrefs blob: the embedded device_pubkey must equal the
 * EXPECTED device, and the signature must validate over the canonical bytes.
 * Never throws.
 */
export function verifySigrefs(signed: SignedSigrefs, expectedDevicePubkeyBase64: string): boolean {
  if (!isSignedSigrefs(signed)) return false;
  if (signed.device_pubkey !== expectedDevicePubkeyBase64) return false;
  try {
    const bytes = sigrefsSigningBytes(signed);
    return verifyEd25519(bytes, expectedDevicePubkeyBase64, Buffer.from(signed.sig, 'base64'));
  } catch {
    return false;
  }
}

export type SigrefsAcceptance =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'bad-signature'
        | 'wrong-device'
        | 'rollback'
        | 'malformed'
        | 'origin-claim-outside-scope'
        | 'legacy-version'
        | 'context-mismatch'
        | 'stale-generation';
    };

/** Does any entry carry a (v2, scope-repo-only) origin claim? */
export function sigrefsCarryOriginClaims(signed: SigrefsPayload): boolean {
  return signed.refs.some((r) => r.originClaim !== undefined);
}

/**
 * Decide whether to ACCEPT a fetched sigrefs for `expectedDevice`, given the
 * version already accepted (`priorVersion`, from readSigrefs on the local mirror
 * — null if none). Combines the signature/device check (G-4) with the monotonic
 * rollback guard (G-4b): the incoming version must strictly exceed the prior.
 * Pure — the caller persists acceptance by storing the new blob.
 *
 * D-017 n2 CONFINEMENT: origin-claim-bearing (v2) sigrefs belong to per-scope
 * repos ONLY. The hive-wide integrator calls this without opts and REFUSES
 * them; a scope-repo integrator passes `allowOriginClaims: true`.
 */
export function acceptFetchedSigrefs(
  signed: SignedSigrefs,
  expectedDevicePubkeyBase64: string,
  priorVersion: number | null,
  opts: { allowOriginClaims?: boolean; expectedContext?: ExpectedSignedProtocolContext; allowLegacy?: boolean; replayFloor?: SignedSnapshotFloor | null } = {},
): SigrefsAcceptance {
  if (!isSignedSigrefs(signed)) return { ok: false, reason: 'malformed' };
  if (signed.v !== SIGREFS_SCHEMA_VERSION_CONTEXT && (opts.allowLegacy !== true || opts.replayFloor)) {
    return { ok: false, reason: 'legacy-version' };
  }
  if (signed.v === SIGREFS_SCHEMA_VERSION_CONTEXT &&
      (!opts.expectedContext || !signedProtocolContextMatches(signed, opts.expectedContext))) {
    return { ok: false, reason: 'context-mismatch' };
  }
  if (signed.device_pubkey !== expectedDevicePubkeyBase64) return { ok: false, reason: 'wrong-device' };
  if (!verifySigrefs(signed, expectedDevicePubkeyBase64)) return { ok: false, reason: 'bad-signature' };
  if (opts.replayFloor) {
    const order = compareGenerationVersion(signed, opts.replayFloor);
    if (order !== 1) return { ok: false, reason: signed.store_generation === opts.replayFloor.store_generation ? 'rollback' : 'stale-generation' };
  } else if (priorVersion !== null && signed.version <= priorVersion) return { ok: false, reason: 'rollback' };
  if (!opts.allowOriginClaims && sigrefsCarryOriginClaims(signed)) {
    return { ok: false, reason: 'origin-claim-outside-scope' };
  }
  return { ok: true };
}

/**
 * Cross-check a fetched namespace's ACTUAL heads (post-fetch) against the shas a
 * verified sigrefs claims. Returns the refs whose fetched sha does NOT match the
 * signed snapshot (an empty array ⇒ every head is exactly what the device
 * signed). The integrator (G-5) trusts only refs that match. Excludes the
 * sigrefs ref itself.
 */
export async function reconcileFetchedHeads(
  repoPath: string,
  devicePubkeyBase64: string,
  signed: SignedSigrefs,
  runGit: RunGit = defaultRunGit,
): Promise<{ ref: string; expected: string; actual: string | null }[]> {
  const signedByRef = new Map(signed.refs.map((r) => [r.ref, r.sha]));
  const actual = await listNamespaceRefs(repoPath, devicePubkeyBase64, runGit);
  const actualByRef = new Map(actual.filter((r) => r.ref !== SIGREFS_REF).map((r) => [r.ref, r.sha]));
  const mismatches: { ref: string; expected: string; actual: string | null }[] = [];
  // A ref the device signed but that is missing/wrong locally, OR a local ref
  // the signature does NOT cover (a relay-injected extra) — both are mismatches.
  for (const [ref, expected] of signedByRef) {
    const got = actualByRef.get(ref) ?? null;
    if (got !== expected) mismatches.push({ ref, expected, actual: got });
  }
  for (const [ref, got] of actualByRef) {
    if (!signedByRef.has(ref)) mismatches.push({ ref, expected: '(unsigned)', actual: got });
  }
  return mismatches;
}

/** The namespace key (hex) for a device — re-exported convenience so callers
 *  don't reach into storage just for the mapping. */
export function sigrefsNamespaceHex(devicePubkeyBase64: string): string {
  return deviceNamespaceKey(devicePubkeyBase64);
}
