/**
 * authority-hardening — re-export shim.
 *
 * The pure fencing + anti-flap leader-election algorithm moved to the generic,
 * borrowable `@papercusp/locks-core` (it is a sibling of the HLC / CRDT /
 * intention-locks primitives extracted from the same `locks-correctness-hardening`
 * work — zero I/O, zero domain coupling; generalize-libs-to-generic-2026-06-05).
 * This shim preserves the in-app import path (`./authority-hardening`) so callers
 * (hardened-authority.ts, lock-authority) are unchanged. Named re-export from the
 * bare specifier (already resolved in operator-core) — not the subpath — so it
 * works regardless of moduleResolution.
 */
export {
  decideAuthority,
  fenceValid,
  canEnforce,
  staleWindowMs,
  type AuthorityRecord,
  type HardeningTiming,
  type AuthorityDecision,
} from '@papercusp/locks-core';
