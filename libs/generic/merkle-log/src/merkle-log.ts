/**
 * RFC 9162 section 2.1 Merkle tree hashing, inclusion proofs and consistency
 * proofs (Certificate Transparency v2). The tree hashing is identical to RFC
 * 6962: SHA-256, a 0x00 prefix on leaves and a 0x01 prefix on interior nodes.
 * RFC 9162 adds the verification algorithms implemented by `verifyInclusion`
 * and `verifyConsistency`.
 *
 * Hashes cross the API as 64-character lowercase hex so proofs serialize as
 * plain JSON. Leaf DATA is opaque bytes: the caller owns the leaf encoding
 * (domain-tag it), this module only hashes it.
 *
 * The builders take the full list of leaf hashes and run in O(n) per call. That
 * is fine for logs of up to a few million leaves recomputed hourly; a caller
 * that outgrows it can cache subtree roots without changing any output.
 */
import { createHash } from 'node:crypto';

const HEX64 = /^[0-9a-f]{64}$/;
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...parts: readonly Uint8Array[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

function toBuf(hex: string, what: string): Buffer {
  if (!HEX64.test(hex)) throw new Error(`${what} must be 64 lowercase hex characters`);
  return Buffer.from(hex, 'hex');
}

/** MTH({}) = SHA-256 of the empty string. */
export const EMPTY_ROOT = sha256().toString('hex');

/** MTH({d}) = SHA-256(0x00 || d). */
export function leafHash(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return sha256(LEAF_PREFIX, bytes).toString('hex');
}

/** SHA-256(0x01 || left || right). */
export function nodeHash(left: string, right: string): string {
  return sha256(NODE_PREFIX, toBuf(left, 'left'), toBuf(right, 'right')).toString('hex');
}

/** Largest power of two strictly less than n (n >= 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function checkLeaves(leafHashes: readonly string[]): void {
  for (let i = 0; i < leafHashes.length; i += 1) {
    if (!HEX64.test(leafHashes[i]!)) throw new Error(`leaf hash ${i} must be 64 lowercase hex characters`);
  }
}

function mth(leaves: readonly string[], lo: number, hi: number): string {
  const n = hi - lo;
  if (n === 0) return EMPTY_ROOT;
  if (n === 1) return leaves[lo]!;
  const k = splitPoint(n);
  return nodeHash(mth(leaves, lo, lo + k), mth(leaves, lo + k, hi));
}

/** The Merkle Tree Hash of the first `treeSize` leaves (default: all of them). */
export function rootHash(leafHashes: readonly string[], treeSize = leafHashes.length): string {
  checkLeaves(leafHashes);
  if (!Number.isInteger(treeSize) || treeSize < 0 || treeSize > leafHashes.length) {
    throw new Error(`treeSize ${treeSize} is outside 0..${leafHashes.length}`);
  }
  return mth(leafHashes, 0, treeSize);
}

function path(leaves: readonly string[], m: number, lo: number, hi: number): string[] {
  const n = hi - lo;
  if (n <= 1) return [];
  const k = splitPoint(n);
  if (m < k) return [...path(leaves, m, lo, lo + k), mth(leaves, lo + k, hi)];
  return [...path(leaves, m - k, lo + k, hi), mth(leaves, lo, lo + k)];
}

/** PATH(m, D[n]): the audit path proving leaf `index` is in the tree of `treeSize` leaves. */
export function inclusionProof(leafHashes: readonly string[], index: number, treeSize = leafHashes.length): string[] {
  checkLeaves(leafHashes);
  if (!Number.isInteger(treeSize) || treeSize < 1 || treeSize > leafHashes.length) {
    throw new Error(`treeSize ${treeSize} is outside 1..${leafHashes.length}`);
  }
  if (!Number.isInteger(index) || index < 0 || index >= treeSize) {
    throw new Error(`index ${index} is outside 0..${treeSize - 1}`);
  }
  return path(leafHashes, index, 0, treeSize);
}

function subproof(leaves: readonly string[], m: number, lo: number, hi: number, complete: boolean): string[] {
  const n = hi - lo;
  if (m === n) return complete ? [] : [mth(leaves, lo, hi)];
  const k = splitPoint(n);
  if (m <= k) return [...subproof(leaves, m, lo, lo + k, complete), mth(leaves, lo + k, hi)];
  return [...subproof(leaves, m - k, lo + k, hi, false), mth(leaves, lo, lo + k)];
}

/** PROOF(m, D[n]): proves the tree of `oldSize` leaves is a prefix of the tree of `newSize` leaves. */
export function consistencyProof(leafHashes: readonly string[], oldSize: number, newSize = leafHashes.length): string[] {
  checkLeaves(leafHashes);
  if (!Number.isInteger(newSize) || newSize < 0 || newSize > leafHashes.length) {
    throw new Error(`newSize ${newSize} is outside 0..${leafHashes.length}`);
  }
  if (!Number.isInteger(oldSize) || oldSize < 0 || oldSize > newSize) {
    throw new Error(`oldSize ${oldSize} is outside 0..${newSize}`);
  }
  if (oldSize === 0 || oldSize === newSize) return [];
  return subproof(leafHashes, oldSize, 0, newSize, true);
}

const isOdd = (n: number): boolean => n % 2 === 1;
const half = (n: number): number => Math.floor(n / 2);

export interface InclusionCheck {
  readonly leafHash: string;
  readonly index: number;
  readonly treeSize: number;
  readonly proof: readonly string[];
  readonly root: string;
}

/** RFC 9162 section 2.1.3.2. Returns false (never throws) for any malformed input. */
export function verifyInclusion(check: InclusionCheck): boolean {
  const { index, treeSize, proof } = check;
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(treeSize) || index < 0 || index >= treeSize) return false;
  if (!HEX64.test(check.leafHash) || !HEX64.test(check.root) || !proof.every((p) => HEX64.test(p))) return false;
  let fn = index;
  let sn = treeSize - 1;
  let r = check.leafHash;
  for (const p of proof) {
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      r = nodeHash(p, r);
      if (!isOdd(fn)) {
        while (!isOdd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return sn === 0 && r === check.root;
}

export interface ConsistencyCheck {
  readonly oldSize: number;
  readonly newSize: number;
  readonly oldRoot: string;
  readonly newRoot: string;
  readonly proof: readonly string[];
}

/** RFC 9162 section 2.1.4.2. Returns false (never throws) for any malformed input. */
export function verifyConsistency(check: ConsistencyCheck): boolean {
  const { oldSize, newSize, proof } = check;
  if (!Number.isSafeInteger(oldSize) || !Number.isSafeInteger(newSize) || oldSize < 0 || oldSize > newSize) return false;
  if (!HEX64.test(check.oldRoot) || !HEX64.test(check.newRoot) || !proof.every((p) => HEX64.test(p))) return false;
  if (oldSize === newSize) return proof.length === 0 && check.oldRoot === check.newRoot;
  if (oldSize === 0) return proof.length === 0 && check.oldRoot === EMPTY_ROOT;
  if (proof.length === 0) return false;
  const isPow2 = (oldSize & (oldSize - 1)) === 0;
  const path = isPow2 ? [check.oldRoot, ...proof] : [...proof];
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (isOdd(fn)) {
    fn = half(fn);
    sn = half(sn);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (isOdd(fn) || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!isOdd(fn)) {
        while (!isOdd(fn) && fn !== 0) {
          fn = half(fn);
          sn = half(sn);
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = half(fn);
    sn = half(sn);
  }
  return fr === check.oldRoot && sr === check.newRoot && sn === 0;
}
