# @papercusp/seed-bundle

A generic **checkpoint-a-replicated-store** primitive.

Ship a **checkpoint** of one or more replicated stores (a git repo, a hypercore
corestore, …) ahead of a live sync so a fresh host **pre-positions the bytes** and
the **unmodified** sync/join protocol then transfers only the **delta** on top.

> **Seed bootstraps BYTES; the live protocol bootstraps TRUST.** A seed is
> untrusted cache — every store re-verifies natively (git object hashes, hypercore
> merkle + signatures) and admission/keys stay the sole trust path. Any
> missing/corrupt/unverifiable seed degrades to the plain cold path.

## What's here (pure core)

- **`manifest.ts`** — the self-describing `SeedManifest` (pot id, cut epoch/HLC,
  per-store entries with `{kind, hash, sizeBytes, source, encryption?}`) + pure
  `validateManifest` / `encodeManifest` / `decodeManifest`. `SeedSource` is
  open-ended (`resource | url | swarm`) so delivery can change without a schema bump.
- **`registry.ts`** — the `SeedProvider` seam (`cut` / `verify` / `restore`) and a
  kind→provider `SeedProviderRegistry`. **The provider is the injection seam** — the
  generic layer never touches git or hypercore itself.
- **`restore.ts`** — `restoreSeed(manifest, registry, resolvePayload, ctx)`: the
  "restore-before-join" step. Validate → per-store verify-then-restore, **failure
  isolating** (one store's failure never aborts the others), returns per-store
  outcomes so the host cold-paths only what failed.

## Who supplies the substrate

Host-side `SeedProvider`s (colocated with their substrates, NOT in this lib):
a **corestore** provider (carries federated state as epoch-ciphertext) and a **git**
provider (a `git bundle` → clone-from-bundle → delta fetch).

## Design

Plan `pot-seed-bundle-2026-07-04`; design memo
`agent-insights/pot-seed-bundle-design`. First consumer: the Papercusp dogfood
installer (skip the second first-boot download while still exercising the real
shared-pot join). Generic by construction; a follow-up may extract this dir to a
standalone submodule like its siblings.
