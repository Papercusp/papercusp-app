# Canonical-form JSON for signed payloads — reach for JCS (RFC 8785)
URL: /internal/docs/agent-insights/jcs-canonical-form-for-signed-json

When you need a signature over a JSON body that verifies across implementations or languages, the canonical-form spec is JCS / RFC 8785. Encode the choice in a const field-order tuple so publisher and verifier cannot drift.

import { Aside } from '@astrojs/starlight/components';

## The setup

You're designing a JSON wire-format where one party signs the body and another party verifies it. The signature is computed over `JSON.stringify(body)` bytes. Pretty straightforward, right?

It isn't. `JSON.stringify` in JavaScript:

* Emits object keys in insertion order, not sorted.
* Has no defined behavior for `NaN` / `Infinity` (throws or becomes `null`).
* Doesn't normalize number formatting (`1.0` vs `1`, scientific notation, etc.).
* Doesn't normalize string escaping (`"A"` vs `"A"`).

Any one of these can produce different bytes from the publisher and the verifier even though the JSON values are identical. The signature breaks. The bug is invisible until someone re-implements the serializer in Go or Rust and now nothing verifies.

## The pattern

**Pick [JCS — JSON Canonicalization Scheme, RFC 8785](https://www.rfc-editor.org/rfc/rfc8785). It's the deterministic-JSON spec.**

JCS specifies:

* Ascending Unicode code-point sort on object keys.
* Number formatting per ECMAScript `ToString` (RFC 8785 §3.2.2.3).
* String escaping per RFC 8259 §7 (no redundant `\uXXXX` for ASCII).
* No whitespace, no trailing newlines.

Result: identical bytes from any JCS-conformant encoder, in any language, for the same JSON value tree.

## How to encode the choice in TypeScript

When you write the *types* module for the signed body (per [`types-first-from-design-memo`](/internal/docs/agent-insights/types-first-from-design-memo/)), include a const tuple naming the canonical field order. The runtime serializer iterates this tuple; if anyone reorders fields silently, the const drifts visibly.

```ts
/**
 * The canonical field-order tuple for `ContributorFileBody`. Implements
 * the chosen canonical-form (JCS / RFC 8785). JCS specifies ascending
 * Unicode code-point order on object keys; this tuple matches that
 * order exactly so a hand-implemented serializer can iterate it
 * without re-sorting.
 */
export const CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER = [
  'device_attestation_gist_id',
  'device_pubkey',
  'github_login',
  'github_user_id',
  'joined_at',
  'signature_by_device',
  'version',
] as const;
```

Then in tests, assert it's actually JCS-conformant ascending sort:

```ts
it('is JCS-compliant ascending unicode-codepoint sort', () => {
  const sorted = [...CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER].sort();
  expect(CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER).toEqual(sorted);
});

it('covers every body field exactly once', () => {
  const fields = Object.keys(sampleBody).sort();
  expect([...CONTRIBUTOR_FILE_CANONICAL_FIELD_ORDER].sort()).toEqual(fields);
});
```

The first test catches "someone reordered the const by hand"; the second catches "someone added a field to the type but forgot the const." Both bugs would silently break signatures in production.

## How signing strips the signature field

The signature scope is "every field except the signature itself" — otherwise you'd need to know the signature before computing it. The types module exports a helper:

```ts
export function stripSignatureForSigning(
  body: ContributorFileBody,
): Omit<ContributorFileBody, 'signature_by_device'> {
  const { signature_by_device: _sig, ...rest } = body;
  void _sig;
  return rest;
}
```

The runtime path is: `JCS.encode(stripSignatureForSigning(body))` → sign those bytes → inject the signature → publish.

The verifier path: receive body → check shape with the structural predicate → `JCS.encode(stripSignatureForSigning(body))` → verify against `body.signature_by_device`.

## Why not hand-rolled "fields sorted A-Z"?

It works until you hit any of:

* A nested object — does each nested object's keys also get sorted?
* A number that JavaScript stringifies differently from Python (`1e3` vs `1000`).
* A string with non-ASCII chars that one impl escapes and another doesn't.
* A null value that one impl emits and another omits.

JCS specifies the answer to all of these. Hand-rolled schemes don't, and you'll discover the gap when a cross-language verifier ships months later.

## Why not protobuf / CBOR / something binary?

Sometimes the right answer. But:

* The body needs to be human-readable (e.g. committed to git as a file someone might view).
* The body needs to be inspectable in GitHub Gist UIs / web tools.
* The body fits in `<1KB` — the size win from binary is negligible.

If those constraints don't apply, prefer binary (CBOR or protobuf) — JSON adds parsing cost on every verify. But for "small signed config files committed to git" or "gist bodies a human might read," JCS is the right answer.

## When to skip JCS entirely

Two cases where JCS is overkill:

**(1) Signatures that stay within one process.** If publisher and verifier are the same Node program (or even same monorepo) and never cross language boundaries, `JSON.stringify` with consistent input objects works. No reason to add a JCS dep.

**(2) Hash-then-sign with detached canonicalization.** If you compute a hash of *content* (not bytes) — like Git's tree hashing — the canonicalization happens at the content layer, not the byte layer. Different problem.

Otherwise: reach for JCS. The 24-hour debugging session you'll skip is worth the 200-LOC dep.

## In this codebase

* [`packages/operator-core/lib/identity/contributor-file-types.ts`](https://github.com/Papercusp/papercup/blob/main/packages/operator-core/lib/identity/contributor-file-types.ts) — the Channel 2 contributor file (Phase 1b P-075). Per `dogfood-design-memo-two-channel-binding-ux-2026-05-24`. JCS field-order const + tests.
* [`packages/operator-core/lib/identity/attestation-types.ts`](https://github.com/Papercusp/papercup/blob/main/packages/operator-core/lib/identity/attestation-types.ts) — the Channel 1 device attestation gist body (Phase 1b P-011). Per `dogfood-design-memo-device-attestation-ux-2026-05-24`. Also targets JCS canonicalization at the byte level when the runtime impl lands.

Both modules ship before the runtime serializer because the field-order const is the load-bearing piece — once it's in tree + tested, downstream implementations cannot diverge from it.

## See also

* [JCS / RFC 8785 spec](https://www.rfc-editor.org/rfc/rfc8785) — short read (\~15 pages), worth bookmarking.
* [`types-first-from-design-memo`](/internal/docs/agent-insights/types-first-from-design-memo/) — the broader pattern this fits into: extract types ahead of behavior so the implementation has a stable spine.
* `dogfood-design-memo-two-channel-binding-ux-2026-05-24.md` — design memo where JCS choice was first surfaced (D-001 in `papercusp-dogfood-phase1b-oauth-clone-attestation-2026-05-24.md`).
