/**
 * App keys — the bearer credential an external app presents to a workspace
 * (external-app-access-to-workspaces-2026-09-29 P-002).
 *
 * Shape: `pcapp_<id>_<secret>`
 *   - `id`     16 chars of [A-Za-z0-9]. PUBLIC: it is the connected_apps row's
 *              primary key, shown in the UI, logged, and used as the principal
 *              slug (`app:<id>`). Fixed length and no `_`, so parsing is
 *              unambiguous whatever the secret contains.
 *   - `secret` 32 random bytes, base64url (43 chars). PRIVATE: shown to the
 *              user once at creation, never stored.
 *
 * What is stored is `sha256(full key)` as lowercase hex (`token_hash`), and a
 * presented key is checked by recomputing that digest and comparing it in
 * constant time. The id lets the lookup be a primary-key read; the digest is
 * what proves possession. A database dump therefore yields no usable key (R-8).
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const APP_KEY_PREFIX = 'pcapp_';
export const APP_KEY_ID_LENGTH = 16;
const APP_KEY_SECRET_BYTES = 32;

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ID_RE = /^[A-Za-z0-9]{16}$/;
/** 32 bytes of base64url without padding is exactly 43 characters. */
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface ParsedAppKey {
  id: string;
  secret: string;
}

export interface MintedAppKey {
  /** Public id — the row's primary key. */
  id: string;
  /** The full key. Return it to the user ONCE; never persist or log it. */
  key: string;
  /** What to store: sha256 hex of `key`. */
  tokenHash: string;
}

/** A fresh public id (unbiased: `randomInt` rejection-samples). */
export function newAppKeyId(): string {
  let id = '';
  for (let i = 0; i < APP_KEY_ID_LENGTH; i += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

/**
 * Mint a new key. The caller stores `id` + `tokenHash` and shows `key` once.
 *
 * Pass `id` to mint a fresh SECRET for an existing row (key rotation, P-015): the id is the row's
 * primary key and the principal slug, so keeping it keeps the key's scopes, caps and audit trail.
 */
export function mintAppKey(id: string = newAppKeyId()): MintedAppKey {
  if (!ID_RE.test(id)) throw new Error('mintAppKey: id must be 16 characters of [A-Za-z0-9]');
  const secret = randomBytes(APP_KEY_SECRET_BYTES).toString('base64url');
  const key = `${APP_KEY_PREFIX}${id}_${secret}`;
  return { id, key, tokenHash: hashAppKey(key) };
}

/** sha256 hex of the full key — the only thing about a secret that is stored. */
export function hashAppKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * True when a bearer CLAIMS to be an app key. A claimed key that then fails
 * to verify must be refused outright — never handed to a weaker resolver
 * further down the auth chain.
 */
export function isAppKeyShaped(token: string | null | undefined): token is string {
  return typeof token === 'string' && token.startsWith(APP_KEY_PREFIX);
}

/** Split a key into id + secret, or null when it is not a well-formed key. */
export function parseAppKey(token: string): ParsedAppKey | null {
  if (!isAppKeyShaped(token)) return null;
  const rest = token.slice(APP_KEY_PREFIX.length);
  if (rest.charAt(APP_KEY_ID_LENGTH) !== '_') return null;
  const id = rest.slice(0, APP_KEY_ID_LENGTH);
  const secret = rest.slice(APP_KEY_ID_LENGTH + 1);
  if (!ID_RE.test(id) || !SECRET_RE.test(secret)) return null;
  return { id, secret };
}

/** Constant-time check that `key` hashes to `storedHash`. */
export function appKeyHashMatches(key: string, storedHash: string | null | undefined): boolean {
  if (typeof storedHash !== 'string' || !HASH_RE.test(storedHash)) return false;
  const presented = Buffer.from(hashAppKey(key), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
