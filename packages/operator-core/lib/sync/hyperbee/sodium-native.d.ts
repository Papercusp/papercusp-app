/**
 * Minimal ambient typings for `sodium-native` (the holepunch native libsodium
 * binding) — it ships no `.d.ts` and there is no `@types/sodium-native`, so a
 * bare `import 'sodium-native'` is `error TS7016`. We only declare the surface the
 * re-key crypto foundation (hive-epoch-crypto-impl.ts) actually uses; sodium's API
 * writes into pre-allocated out buffers and returns void/number/boolean.
 *
 * Scope intentionally tiny — extend if more of sodium is used. If sodium-native
 * later ships its own types, delete this file.
 */
declare module 'sodium-native' {
  export const crypto_box_PUBLICKEYBYTES: number;
  export const crypto_box_SECRETKEYBYTES: number;
  export const crypto_box_SEALBYTES: number;
  export const crypto_sign_PUBLICKEYBYTES: number;
  export const crypto_sign_SECRETKEYBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
  export const crypto_aead_xchacha20poly1305_ietf_ABYTES: number;

  export function randombytes_buf(buf: Buffer): void;

  export function crypto_box_seal(out: Buffer, message: Buffer, publicKey: Buffer): void;
  export function crypto_box_seal_open(
    out: Buffer,
    ciphertext: Buffer,
    publicKey: Buffer,
    secretKey: Buffer,
  ): boolean;

  export function crypto_sign_seed_keypair(publicKey: Buffer, secretKey: Buffer, seed: Buffer): void;
  export function crypto_sign_ed25519_pk_to_curve25519(x25519Pk: Buffer, ed25519Pk: Buffer): void;
  export function crypto_sign_ed25519_sk_to_curve25519(x25519Sk: Buffer, ed25519Sk: Buffer): void;

  export function crypto_aead_xchacha20poly1305_ietf_encrypt(
    ciphertext: Buffer,
    message: Buffer,
    additionalData: Buffer | null,
    secretNonce: null,
    publicNonce: Buffer,
    key: Buffer,
  ): number;
  export function crypto_aead_xchacha20poly1305_ietf_decrypt(
    message: Buffer,
    secretNonce: null,
    ciphertext: Buffer,
    additionalData: Buffer | null,
    publicNonce: Buffer,
    key: Buffer,
  ): number;
}
