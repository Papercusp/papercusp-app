# cupboard-actions

Optional **provenance** for third-party Papercusp Cupboard listings.

A reusable GitHub Actions workflow that computes the canonical tree digest of
your listing directory (`<listing_ref>/`) and signs a Sigstore build attestation
for it. The Cupboard shows an attested listing with a "built by the Papercusp
workflow" badge.

## Use it

```yaml
# .github/workflows/cupboard-attest.yml in YOUR repository
name: cupboard-attest
on:
  push:
    branches: [main]
permissions:
  contents: read
  id-token: write
  attestations: write
jobs:
  attest:
    uses: Papercusp/cupboard-actions/.github/workflows/verify.yml@v1
    with:
      listing_ref: recipes/my-recipe   # the directory your listing installs from
```

Your repository must be public (the public-good Sigstore instance signs public
repositories).

## What the badge does — and does not — mean

- **It is a badge, never a gate.** The Cupboard fetches your bytes itself, pins
  their digest, and scans them whether or not an attestation exists. A listing
  with no attestation, or one whose attestation fails verification, publishes and
  installs exactly as before.
- **It binds three things:** the tree digest, the repository + commit that
  produced it, and *this workflow's ref* (so the digest was computed by this
  code, not by a script you wrote). The Worker accepts the attestation only when
  the digest equals the one it pinned from the same commit.
- **It is not a safety review.** It says where the digest came from, not that the
  content is safe.

## Source of truth

This repository is a mirror of `apps/operator-public/cupboard-actions/` in the
Papercusp monorepo, where the digest script is pinned bit-for-bit to the Worker's
`canonicalTreeDigest` by a parity test. Send changes there.
