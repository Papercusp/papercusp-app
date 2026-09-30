/// <reference path="./sodium-native.d.ts" />
// ^ The ambient `sodium-native` typings travel WITH this file. Without the reference, any
//   program that reaches this module transitively but does not include the sibling d.ts
//   (packages/agent-mcp's tsc leg) reports TS7016 on the `import('sodium-native')` below.
/**
 * The hive-epoch op AEAD framing, with no keychain or identity imports, so a worker
 * thread can open an envelope without dragging in the device-key stack.
 *
 * `hive-epoch-crypto-impl.ts` seals and opens ops through these helpers, and the
 * snapshot-fold worker opens `{__rekey}` rows with {@link openOpCiphertext} directly
 * (p2p-join-catchup-speed D-024: P-530's receipt filter must judge the plaintext of an
 * encrypted own-log row). One framing, so the two can never disagree about the bytes.
 *
 * Ciphertext layout: `nonce (NPUBBYTES) || XChaCha20-Poly1305 ciphertext+tag`.
 */
import type { OpAAD } from './hive-epoch-crypto';

export type Sodium = typeof import('sodium-native');

// Lazy native load — import-safe in the SPA bundle; resolved on first real call.
let sodiumP: Promise<Sodium> | null = null;
export function loadSodium(): Promise<Sodium> {
  return (sodiumP ??= import('sodium-native').then(
    (m) => (m as unknown as { default?: Sodium }).default ?? (m as unknown as Sodium),
  ));
}

/**
 * Canonical associated-data bytes — LENGTH-PREFIXED so the (potId, epoch, opId)
 * fields can't be re-split into a different but equal concatenation (e.g.
 * potId="a",opId="b" vs potId="a",opId... — a delimiter could be forged; a
 * 4-byte length prefix per field is unambiguous).
 */
export function encodeOpAAD(ad: OpAAD): Buffer {
  const parts = [Buffer.from(ad.potId, 'utf8'), Buffer.from(String(ad.epoch), 'utf8'), Buffer.from(ad.opId, 'utf8')];
  const out: Buffer[] = [];
  for (const p of parts) {
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(p.length);
    out.push(len, p);
  }
  return Buffer.concat(out);
}

/**
 * Open one op envelope SYNCHRONOUSLY with an already-loaded sodium. Throws on a short
 * ciphertext or an auth failure (wrong key / wrong AAD / tamper) — the fail-closed
 * behavior `HiveEpochCrypto.decryptOp` requires.
 */
export function openOpCiphertext(s: Sodium, ciphertext: Uint8Array, key: Uint8Array, ad: OpAAD): Buffer {
  const NP = s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES;
  const AB = s.crypto_aead_xchacha20poly1305_ietf_ABYTES;
  const buf = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
  if (buf.length < NP + AB) throw new Error('ciphertext too short');
  const nonce = buf.subarray(0, NP);
  const c = buf.subarray(NP);
  const m = Buffer.allocUnsafe(c.length - AB);
  // sodium-native throws on auth failure — the correct fail-closed behavior.
  s.crypto_aead_xchacha20poly1305_ietf_decrypt(m, null, c, encodeOpAAD(ad), nonce, Buffer.from(key));
  return m;
}
