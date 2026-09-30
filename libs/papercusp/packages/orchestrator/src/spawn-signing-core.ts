/**
 * spawn-signing-core.ts — the ONE source of the spawn-URL signing PRIMITIVES:
 * the signed-param allowlist, the canonicalization rule, and the HMAC.
 *
 * Background (unify-launch-mechanics follow-on — signing dedup): the signer
 * (`apps/operator` → `packages/operator-core/lib/spawn-signing.ts`) and the
 * orchestrator's spawn-time signer (`spawn-mcp.ts`) run in SEPARATE processes, so
 * the orchestrator can't import the operator app. The allowlist + canonicalization
 * + HMAC were therefore DUPLICATED in both, with a "keep in lockstep or signatures
 * mismatch" comment — a real drift hazard (add a param on one side only → every
 * spawned agent's signed MCP URL fails to verify).
 *
 * The fix: both processes CAN import this orchestrator-package module (operator-core
 * already imports `@papercusp/orchestrator/*`; spawn-mcp imports it as a sibling),
 * so the primitives live here ONCE. Per-process KEY LOADING stays in each file
 * (they read the key from PG via genuinely different clients/caches) — only the
 * pure crypto rule is shared, which is exactly the part that must never drift.
 *
 * Pure (crypto + string math), no I/O, no PG, no domain coupling beyond the
 * papercusp param names.
 */
import { createHmac } from 'node:crypto';

/**
 * Params that are part of the signed envelope. Order doesn't matter — the
 * canonicalization sorts them. A param NOT in this set is ignored by the
 * canonicalizer, so a forger can't sneak an extra signed param in, and the
 * verifier can't be tricked by reordering or appending.
 */
export const SIGNED_PARAM_ALLOWLIST: ReadonlySet<string> = new Set([
  'harness',
  'workspace',
  'role',
  'run',
  'spawn',
  'feature',
  'chunk',
  'parent_spawn',
  'client',
  'detector',
  'exp',
]);

export type CanonicalizeResult =
  | { ok: true; canonical: string }
  | { ok: false; reason: string };

/**
 * Canonical string built from the signed-allowlist params (sorted by name, joined
 * with `&`, values `encodeURIComponent`-encoded). Ignores `sig` itself and any
 * param not in the allowlist. Rejects duplicate keys — otherwise a forger could
 * append `&role=operator` AFTER the signed one and have the parser pick the later
 * value (reason `duplicate_param:<key>`).
 */
export function canonicalizeSpawnParams(params: URLSearchParams): CanonicalizeResult {
  const seen = new Set<string>();
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED_PARAM_ALLOWLIST.has(k)) continue;
    if (seen.has(k)) return { ok: false, reason: `duplicate_param:${k}` };
    seen.add(k);
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    ok: true,
    canonical: pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&'),
  };
}

/** HMAC-SHA256 of a canonical string with the given key → raw bytes. The signer
 *  formats it (`.toString('base64url')`); the verifier compares raw bytes via
 *  `timingSafeEqual`. */
export function hmacSpawnBytes(key: Buffer, canonical: string): Buffer {
  return createHmac('sha256', key).update(canonical).digest();
}

/* ─── Key DECODING (pure) ────────────────────────────────────────────────────
 * Per-process key LOADING stays in each file (different PG clients + caches, as
 * the header says). The pure decode-and-validate rule lives HERE for the same
 * reason the canonicalization does: all three loaders of the `spawn-signing-key`
 * row must agree, and a validator that exists in only some of them is a drift
 * hazard of exactly the kind this module was created to remove.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every `operator_secrets` HMAC key on this path is 32 random bytes. */
export const OPERATOR_SECRET_KEY_BYTES = 32;

/** Greppable marker leading every corruption failure, so a log line alone names
 *  the cause instead of leaving a downstream signature error to be traced back. */
export const OPERATOR_SECRET_KEY_CORRUPT = 'OPERATOR_SECRET_KEY_CORRUPT';

/**
 * Decode a base64 `operator_secrets` value and assert it is the size it was minted at.
 *
 * WHY: `Buffer.from(value, 'base64')` NEVER THROWS. Given an empty string, whitespace,
 * a truncated value, or non-base64 garbage it silently returns a SHORTER (often
 * zero-length) buffer, and `createHmac` then accepts that degenerate key without
 * complaint. Because the signing and verifying paths load the SAME degenerate key,
 * every signature still verifies and every probe stays green — while the security
 * property (an unguessable 32-byte secret) is gone. A silent downgrade that is
 * indistinguishable from health, which is why it needs an explicit assertion.
 *
 * Measured: `''`→0 bytes · `'   '`→0 · `'!!!!not base64!!!!'`→6 · `'AAAA'`→3.
 *
 * FAILS LOUD, DOES NOT SELF-HEAL: re-minting on read would silently invalidate every
 * live signed URL/token — precisely the blast radius a deliberate rotation exists to
 * report BEFORE it happens. Restoring vs rotating is an operator decision.
 */
export function decodeOperatorSecretKey(
  valueB64: string | null | undefined,
  keyName: string,
  expectedBytes: number = OPERATOR_SECRET_KEY_BYTES,
): Buffer {
  if (typeof valueB64 !== 'string' || valueB64.length === 0) {
    throw new Error(
      `${OPERATOR_SECRET_KEY_CORRUPT}: operator_secrets row '${keyName}' has an empty or missing ` +
        `value_b64. Buffer.from() would have silently produced a 0-byte key that still signs and ` +
        `verifies, so this fails instead. Restore the row from backup, or rotate the key ` +
        `deliberately (which invalidates live spawns/tokens).`,
    );
  }

  const buf = Buffer.from(valueB64, 'base64');

  if (buf.length !== expectedBytes) {
    throw new Error(
      `${OPERATOR_SECRET_KEY_CORRUPT}: operator_secrets row '${keyName}' decoded to ${buf.length} ` +
        `byte(s), expected ${expectedBytes}. base64 decoding does not throw on corrupt input — it ` +
        `truncates — so this row would otherwise have yielded a short, guessable key that signs and ` +
        `verifies normally. Restore the row from backup, or rotate the key deliberately ` +
        `(which invalidates live spawns/tokens).`,
    );
  }

  return buf;
}
