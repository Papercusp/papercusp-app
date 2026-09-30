/**
 * Decoding secrets out of `harness_shared.operator_secrets`.
 *
 * THE IMPLEMENTATION LIVES IN `@papercusp/orchestrator/spawn-signing-core`, not here.
 * Three processes load the same `spawn-signing-key` row — operator-core's verifier
 * (`spawn-signing.ts`), operator-core's power-user token path (`power-user-token.ts`),
 * and the orchestrator's spawn-time signer (`spawn-mcp.ts`) — and the orchestrator
 * cannot import operator-core. `spawn-signing-core` is the module all of them already
 * share, and it exists precisely so a rule that must never drift between them has one
 * home. A second copy of a security check here would be the drift hazard this fix is
 * about, so this file is a re-export seam and nothing more.
 *
 * WHY THE CHECK EXISTS — `Buffer.from(value, 'base64')` NEVER THROWS. On an empty
 * string, whitespace, a truncated value, or non-base64 garbage it silently returns a
 * SHORTER (often zero-length) buffer, and `createHmac` accepts that degenerate key
 * without complaint. Signing and verifying both load the SAME degenerate key, so every
 * signature still verifies and every probe stays green while the security property (an
 * unguessable 32-byte secret) is gone — a silent downgrade that looks exactly like
 * health. Coverage + falsifiability proof: `operator-secret-key.test.ts`.
 */

export {
  decodeOperatorSecretKey,
  OPERATOR_SECRET_KEY_BYTES,
  OPERATOR_SECRET_KEY_CORRUPT,
} from '@papercusp/orchestrator/spawn-signing-core';
