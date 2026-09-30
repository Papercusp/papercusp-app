/**
 * pot-git/handoff-token.ts — the sha-token authority handoff + park-token
 * protocol (Phase 7 G-0 / G-0b, cross-machine-coord-parity-and-trust-2026-07-01
 * / P-033, P-037; D-011 holes 1+2).
 *
 * WHY (G-0, the intent-plane keystone): the integrator authority is a
 * deterministic argmin over live presence (authority/lock-authority.ts) — when
 * it changes hands the NEW authority must continue staging from the OLD
 * authority's last published sha, never rewind. The OUTGOING authority
 * publishes a signed HANDOFF TOKEN `(stagingSha, epoch, seq, parked[])` as a
 * blob in ITS OWN namespace (`refs/rad/handoff`, the sigrefs pattern — it
 * federates with the namespace fetch); the INCOMING authority ADOPTS it before
 * its first advance: seed own staging at the token's sha and start publishing
 * at epoch N+1 (G-5d fencing then rejects any late advance from the old epoch).
 *
 * PARK TOKENS (G-0b, hole 1 — the park × lock-token deadlock): when the
 * integrator PARKS a member head H (a 3-way conflict — integrator.ts
 * `skippedConflicts`), every sha-token lock grant whose `requiredSha` points
 * INTO H would otherwise strand: staging will never contain requiredSha until
 * the member rebases, so the acquirer stalls to timeout. So parked heads ride
 * the handoff token (a resumed/new authority resumes knowing H is parked, not
 * lost) and {@link classifyRequiredSha} downgrades such grants to `parked` —
 * the grantee is LOUDLY offered build-on-staging vs build-on-parked-head
 * instead of silently waiting ({@link gradeShaTokenGrant}).
 *
 * CRASH PATH (no token): a dead authority never published one. The incoming
 * authority then derives its base from {@link resolveMaxObservedStaging} — the
 * ancestry-maximal staging across every device namespace (the sigrefs-verified
 * mirror), per P-038 "new integrator builds on max observed staging before
 * epoch N+1".
 *
 * The lock-authority WIRING (locks:release publishes-then-releases, grants
 * carrying requiredSha, expiry-reclaim grants carrying unsyncedRisk) lives with
 * authority/lock-authority.ts + the locks verbs and is coordinated separately —
 * this module is the storage/token layer both sides call.
 *
 * Pure over ed25519.ts + storage.ts's RunGit seam; tests run against a real
 * temp bare repo with injected signers.
 */

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEd25519 } from '../../identity/ed25519';
import {
  type RunGit,
  defaultRunGit,
  deviceNamespaceKey,
  readNamespaceRef,
  readNamespaceRefForDevices,
  writeNamespaceRef,
} from './storage';
import { STAGING_REF } from './integrator';
import type { EpochSeq } from './staging-advance';

/** The within-namespace ref that holds the signed handoff-token blob. */
export const HANDOFF_REF = 'refs/rad/handoff';

/** Wire schema version for the handoff token. */
export const HANDOFF_TOKEN_SCHEMA_VERSION = 1;

/** Domain-separation tag for handoff-token signatures (hive-policy idiom). */
export const HANDOFF_TOKEN_SIG_DOMAIN = 'papercusp-pot-git-handoff-token-v1';

/** A member head the integrator could not integrate yet (3-way conflict). */
export interface ParkedHead {
  /** The member device's namespace key (hex). */
  deviceHex: string;
  /** The parked work-head sha. */
  sha: string;
}

/** The signed handoff payload — fixed field order, parked sorted by deviceHex. */
export interface HandoffTokenPayload extends EpochSeq {
  /** Wire schema version. */
  v: number;
  /** The OUTGOING authority device's raw-32 Ed25519 pubkey (base64). */
  device_pubkey: string;
  /** The outgoing authority's last published staging sha. */
  staging_sha: string;
  /** Heads parked at handoff time (G-0b) — the incoming authority resumes knowing these. */
  parked: ParkedHead[];
  /** Handoff time (epoch ms) — audit only. */
  ts: number;
}

export interface SignedHandoffToken extends HandoffTokenPayload {
  /** base64 Ed25519 signature over handoffTokenSigningBytes(payload). */
  sig: string;
}

const SHA_RE = /^[0-9a-f]{40,64}$/;
const HEX_RE = /^[0-9a-f]{64}$/;

function isParkedHead(x: unknown): x is ParkedHead {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return typeof p.deviceHex === 'string' && HEX_RE.test(p.deviceHex) && typeof p.sha === 'string' && SHA_RE.test(p.sha);
}

function isHandoffTokenPayload(x: unknown): x is HandoffTokenPayload {
  if (!x || typeof x !== 'object') return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.v === 'number' &&
    typeof t.device_pubkey === 'string' &&
    typeof t.epoch === 'number' &&
    Number.isInteger(t.epoch) &&
    (t.epoch as number) >= 0 &&
    typeof t.seq === 'number' &&
    Number.isInteger(t.seq) &&
    (t.seq as number) >= 0 &&
    typeof t.staging_sha === 'string' &&
    SHA_RE.test(t.staging_sha) &&
    Array.isArray(t.parked) &&
    t.parked.every(isParkedHead) &&
    typeof t.ts === 'number'
  );
}

export function isSignedHandoffToken(x: unknown): x is SignedHandoffToken {
  return isHandoffTokenPayload(x) && typeof (x as unknown as Record<string, unknown>).sig === 'string';
}

/** Canonical signing bytes: domain tag + fixed field order, parked pre-sorted. */
export function handoffTokenSigningBytes(payload: HandoffTokenPayload): Buffer {
  const ordered = {
    v: payload.v,
    device_pubkey: payload.device_pubkey,
    epoch: payload.epoch,
    seq: payload.seq,
    staging_sha: payload.staging_sha,
    parked: [...payload.parked]
      .sort((a, b) => a.deviceHex.localeCompare(b.deviceHex))
      .map((p) => ({ deviceHex: p.deviceHex, sha: p.sha })),
    ts: payload.ts,
  };
  return Buffer.from(`${HANDOFF_TOKEN_SIG_DOMAIN}\n${JSON.stringify(ordered)}`, 'utf8');
}

/** hash-object a UTF-8 blob into the ODB (temp-file path, RunGit-seam safe). */
async function hashBlob(repoPath: string, content: string, runGit: RunGit): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'handoff-'));
  try {
    const f = join(dir, 'blob');
    await writeFile(f, content, 'utf8');
    const r = await runGit(['hash-object', '-w', '-t', 'blob', f], repoPath);
    if (r.code !== 0) throw new Error(`pot-git: hash-object failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Build, sign and PUBLISH the outgoing authority's handoff token: write the
 * signed blob and point `refs/namespaces/<dev>/refs/rad/handoff` at it. The
 * `publish-then-release` ordering is the caller's (locks-side) contract: call
 * this BEFORE releasing the authority lease/locks so the token is always
 * observable by the successor. Returns the signed token.
 */
export async function publishHandoffToken(
  repoPath: string,
  devicePubkeyBase64: string,
  fields: { epoch: number; seq: number; stagingSha: string; parked?: ParkedHead[]; nowMs: number },
  sign: (bytes: Buffer) => Promise<Buffer>,
  opts: { runGit?: RunGit } = {},
): Promise<SignedHandoffToken> {
  const runGit = opts.runGit ?? defaultRunGit;
  const payload: HandoffTokenPayload = {
    v: HANDOFF_TOKEN_SCHEMA_VERSION,
    device_pubkey: devicePubkeyBase64,
    epoch: fields.epoch,
    seq: fields.seq,
    staging_sha: fields.stagingSha,
    parked: [...(fields.parked ?? [])].sort((a, b) => a.deviceHex.localeCompare(b.deviceHex)),
    ts: fields.nowMs,
  };
  if (!isHandoffTokenPayload(payload)) {
    throw new Error('pot-git: publishHandoffToken called with a malformed payload');
  }
  const sig = (await sign(handoffTokenSigningBytes(payload))).toString('base64');
  const signed: SignedHandoffToken = { ...payload, sig };
  const blobSha = await hashBlob(repoPath, JSON.stringify(signed), runGit);
  await writeNamespaceRef(repoPath, devicePubkeyBase64, HANDOFF_REF, blobSha, runGit);
  return signed;
}

/** Read + parse the handoff token published by `devicePubkeyBase64` (null if
 *  none / malformed). The caller verifies with {@link verifyHandoffToken}. */
export async function readHandoffToken(
  repoPath: string,
  devicePubkeyBase64: string,
  runGit: RunGit = defaultRunGit,
): Promise<SignedHandoffToken | null> {
  const blobSha = await readNamespaceRef(repoPath, devicePubkeyBase64, HANDOFF_REF, runGit);
  if (!blobSha) return null;
  const r = await runGit(['cat-file', 'blob', blobSha], repoPath);
  if (r.code !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as SignedHandoffToken;
    return isSignedHandoffToken(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Verify a handoff token: the embedded device must equal the EXPECTED outgoing
 * authority (when given) and the signature must validate. Never throws.
 */
export function verifyHandoffToken(signed: SignedHandoffToken, expectedDevicePubkeyBase64?: string): boolean {
  if (!isSignedHandoffToken(signed)) return false;
  if (expectedDevicePubkeyBase64 !== undefined && signed.device_pubkey !== expectedDevicePubkeyBase64) return false;
  try {
    return verifyEd25519(handoffTokenSigningBytes(signed), signed.device_pubkey, Buffer.from(signed.sig, 'base64'));
  } catch {
    return false;
  }
}

const ZERO_SHA = '0'.repeat(40);

export type AdoptHandoffResult =
  | {
      ok: true;
      /** The staging sha the incoming authority now continues from. */
      staging: string;
      /** False when our own staging was already at/ahead of the token (no ref write). */
      adopted: boolean;
      /** The epoch the incoming authority must publish under (token.epoch + 1). */
      nextEpoch: number;
      /** The token's parked heads — carry into grant classification (G-0b). */
      parked: ParkedHead[];
    }
  | { ok: false; reason: 'bad-signature' | 'missing-objects' | 'diverged' };

/**
 * ADOPT a (verified-signature) handoff token as the INCOMING authority: seed
 * our own namespace's staging ref at the token's sha so our first
 * `integrateMemberHeads` builds ON it — every subsequent staging is then a
 * descendant of the old authority's last publish (never a rewind). Rules:
 *
 *   - token sha not present locally → `missing-objects` (fetch the old
 *     authority's namespace first, then retry);
 *   - our staging already AT or AHEAD of (descendant of) the token sha → ok,
 *     `adopted:false`, continue from our own (a stale token never rewinds us);
 *   - our staging diverged from the token sha → `diverged` (integrate first —
 *     e.g. feed the token sha through integrateMemberHeads — then adopt);
 *   - otherwise (no staging yet, or ours is an ancestor) → fast-forward our
 *     staging to the token sha (CAS-guarded).
 *
 * Membership/authority gating of `token.device_pubkey` is the caller's job
 * (same contract as sigrefs/staging-advance).
 */
export async function adoptHandoffToken(
  repoPath: string,
  incomingDevicePubkeyBase64: string,
  token: SignedHandoffToken,
  opts: { runGit?: RunGit } = {},
): Promise<AdoptHandoffResult> {
  const runGit = opts.runGit ?? defaultRunGit;
  if (!verifyHandoffToken(token)) return { ok: false, reason: 'bad-signature' };

  const exists = await runGit(['rev-parse', '--verify', '-q', `${token.staging_sha}^{commit}`], repoPath);
  if (exists.code !== 0) return { ok: false, reason: 'missing-objects' };

  const nextEpoch = token.epoch + 1;
  const own = await readNamespaceRef(repoPath, incomingDevicePubkeyBase64, STAGING_REF, runGit);

  if (own !== null) {
    if (own === token.staging_sha) {
      return { ok: true, staging: own, adopted: false, nextEpoch, parked: token.parked };
    }
    // Token sha already contained in ours → we are ahead; a stale token must
    // never rewind us.
    const tokenInOwn = await runGit(['merge-base', '--is-ancestor', token.staging_sha, own], repoPath);
    if (tokenInOwn.code === 0) {
      return { ok: true, staging: own, adopted: false, nextEpoch, parked: token.parked };
    }
    // Ours contained in token's → plain fast-forward. Anything else = diverged.
    const ownInToken = await runGit(['merge-base', '--is-ancestor', own, token.staging_sha], repoPath);
    if (ownInToken.code !== 0) return { ok: false, reason: 'diverged' };
  }

  await writeNamespaceRef(
    repoPath,
    incomingDevicePubkeyBase64,
    STAGING_REF,
    token.staging_sha,
    runGit,
    own ?? ZERO_SHA,
  );
  return { ok: true, staging: token.staging_sha, adopted: true, nextEpoch, parked: token.parked };
}

export interface MaxObservedStaging {
  /** The ancestry-maximal staging sha observed across all device namespaces. */
  sha: string;
  /** The device (hex) whose namespace published it (lowest hex on a tie). */
  deviceHex: string;
  /** True when observed stagings DIVERGE (no single maximal head) — the
   *  returned sha is then the deterministic pick among the maximal set and the
   *  new authority should integrate the rest as member heads. */
  diverged: boolean;
  /** Every maximal head (length > 1 ⇔ diverged). */
  maximal: { sha: string; deviceHex: string }[];
}

/**
 * The CRASH-PATH base resolver (P-038 leg): with no adoptable handoff token, a
 * new authority derives its starting base as the maximal observed staging
 * across the given devices' namespaces (post sigrefs verification — pass only
 * devices whose namespaces verified). Maximal = not an ancestor of any other
 * observed staging. On divergence (two ex-authorities raced) the pick is
 * deterministic (lowest device hex among the maximal set) and `diverged` is
 * set so the caller integrates the others as member heads before publishing.
 * Returns null when no device has a staging ref.
 */
export async function resolveMaxObservedStaging(
  repoPath: string,
  devicePubkeysBase64: readonly string[],
  runGit: RunGit = defaultRunGit,
  /**
   * The last staging SHA accepted by the bridge, when the caller has one.
   * A tokenless crash takeover must never let an unrelated namespace history
   * become its base: only heads that descend from this accepted SHA are
   * admissible. The accepted SHA itself is a safe synthetic base when no
   * descendant namespace is available (the bridge already proved it).
   */
  acceptedBaseSha?: string | null,
): Promise<MaxObservedStaging | null> {
  const baseSha = acceptedBaseSha && SHA_RE.test(acceptedBaseSha)
    ? (await runGit(['rev-parse', '--verify', '-q', `${acceptedBaseSha}^{commit}`], repoPath)).code === 0
      ? acceptedBaseSha
      : null
    : null;

  // Observed (deviceHex, sha), deduped by sha keeping the lowest device hex.
  const byDevice: { deviceHex: string; sha: string }[] = [];
  // ONE `for-each-ref` for every device, not one `git` spawn per device —
  // see readNamespaceRefForDevices (EI-18808838427010743).
  const shas = await readNamespaceRefForDevices(repoPath, devicePubkeysBase64, STAGING_REF, runGit);
  for (const dev of devicePubkeysBase64) {
    const sha = shas.get(dev);
    if (!sha) continue;
    // When the bridge supplied a trusted base, a namespace on an unrelated
    // root/history is not a candidate for takeover. Keeping it in the mirror
    // is fine (the member may still reconcile it later), but allowing it into
    // the maximal-base set wedges the successor forever on
    // `blocked-crash-reconciliation`.
    if (baseSha) {
      const descends = await runGit(['merge-base', '--is-ancestor', baseSha, sha], repoPath);
      if (descends.code !== 0) continue;
    }
    byDevice.push({ deviceHex: deviceNamespaceKey(dev), sha });
  }
  // The accepted bridge watermark is itself a proven publish base. Use it as
  // a deterministic floor when every observed namespace is stale/unrelated.
  if (baseSha) byDevice.push({ deviceHex: '0'.repeat(64), sha: baseSha });
  if (byDevice.length === 0) return null;
  const bySha = new Map<string, string>(); // sha → lowest deviceHex
  for (const o of byDevice.sort((a, b) => a.deviceHex.localeCompare(b.deviceHex))) {
    if (!bySha.has(o.sha)) bySha.set(o.sha, o.deviceHex);
  }
  const distinct = [...bySha.keys()];
  const maximal: { sha: string; deviceHex: string }[] = [];
  for (const sha of distinct) {
    let dominated = false;
    for (const other of distinct) {
      if (other === sha) continue;
      // sha strictly contained in other → dominated.
      const r = await runGit(['merge-base', '--is-ancestor', sha, other], repoPath);
      if (r.code === 0) {
        dominated = true;
        break;
      }
    }
    if (!dominated) maximal.push({ sha, deviceHex: bySha.get(sha)! });
  }
  maximal.sort((a, b) => a.deviceHex.localeCompare(b.deviceHex));
  const pick = maximal[0];
  return { sha: pick.sha, deviceHex: pick.deviceHex, diverged: maximal.length > 1, maximal };
}

/** How a sha-token lock grant's requiredSha relates to the current integration state. */
export type RequiredShaClass =
  | { status: 'in-staging' }
  | { status: 'parked'; parkedHead: ParkedHead }
  | { status: 'unknown' };

/**
 * Classify a lock grant's `requiredSha` against the current staging + parked
 * set (G-0b): contained in staging → the grant completes normally; contained
 * in a PARKED head → the grant must DOWNGRADE to `parked` (never silently
 * stall waiting for a staging that will not come); neither → unknown
 * (`unsyncedRisk` — e.g. an expiry-reclaim before the holder's work synced).
 */
export async function classifyRequiredSha(
  repoPath: string,
  requiredSha: string,
  stagingSha: string | null,
  parked: readonly ParkedHead[],
  runGit: RunGit = defaultRunGit,
): Promise<RequiredShaClass> {
  if (stagingSha !== null) {
    if (requiredSha === stagingSha) return { status: 'in-staging' };
    const inStaging = await runGit(['merge-base', '--is-ancestor', requiredSha, stagingSha], repoPath);
    if (inStaging.code === 0) return { status: 'in-staging' };
  }
  for (const p of parked) {
    if (requiredSha === p.sha) return { status: 'parked', parkedHead: p };
    const inParked = await runGit(['merge-base', '--is-ancestor', requiredSha, p.sha], repoPath);
    if (inParked.code === 0) return { status: 'parked', parkedHead: p };
  }
  return { status: 'unknown' };
}

/** The grant-facing shape the locks layer attaches to a sha-token grant. */
export interface ShaTokenGrantGrade {
  mode: 'clean' | 'parked' | 'unsynced-risk';
  /** True when the acquirer must be warned the prior holder's work may not have synced. */
  unsyncedRisk: boolean;
  /** Set in `parked` mode — the conflicted head the requiredSha lives in. */
  parkedHead?: ParkedHead;
  /** LOUD, human/agent-facing label — never a silent stall (D-011 hole 1). */
  label: string;
}

/**
 * Map a {@link RequiredShaClass} to the grant grade + the LOUD label the locks
 * layer must surface with the grant. `parked` grants offer the explicit choice
 * (build on staging vs build on the parked namespace head); `unknown` grants
 * carry `unsyncedRisk:true` (the expiry-reclaim path).
 */
export function gradeShaTokenGrant(cls: RequiredShaClass, requiredSha: string): ShaTokenGrantGrade {
  switch (cls.status) {
    case 'in-staging':
      return {
        mode: 'clean',
        unsyncedRisk: false,
        label: `prior holder's work (${requiredSha.slice(0, 8)}) is integrated in staging — build on staging.`,
      };
    case 'parked':
      return {
        mode: 'parked',
        unsyncedRisk: false,
        parkedHead: cls.parkedHead,
        label:
          `⚠ prior holder's work (${requiredSha.slice(0, 8)}) is PARKED in a conflicted head ` +
          `(${cls.parkedHead.sha.slice(0, 8)}, device ${cls.parkedHead.deviceHex.slice(0, 12)}) awaiting rebase. ` +
          `Choose: build on STAGING (without that work) or build on the PARKED namespace head (pre-integration). ` +
          `Do not wait for staging to contain it.`,
      };
    case 'unknown':
      return {
        mode: 'unsynced-risk',
        unsyncedRisk: true,
        label:
          `⚠ prior holder's work (${requiredSha.slice(0, 8)}) is in NEITHER staging NOR a parked head — ` +
          `the previous grant likely expired before its work synced (unsyncedRisk). Proceed on staging with care.`,
      };
  }
}
