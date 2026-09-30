# @papercusp/artifact-registry

A **generic artifact registry**: publish/install distributable artifacts
(plugins, snapshots, blueprints, package versions…) over a **pluggable storage
backend**. Zero domain coupling — no Cloudflare, no SQL, no HTTP framework, no
auth provider. Web-Crypto only, so it runs identically in Node 18+, Cloudflare
Workers, Deno, and browsers.

Two composable layers, each behind a small port the host wires its own backend +
domain into (the documented `configure*()`/seam convention):

## Layer A — content-addressed blob store (the bytes)

The "publish/install over a pluggable storage backend" core. An artifact's bytes
live in a `BlobStore`, content-addressed by their SHA-256 (the key *is* the
hash), so identical content dedupes for free and a tampered blob can't
masquerade under a key it doesn't hash to.

```ts
import { contentAddressing, putContentAddressed, getContentAddressed, gcIfUnreferenced } from '@papercusp/artifact-registry';

const scheme = contentAddressing({ prefix: 'snapshots', ext: '.tar.gz' }); // key(sha) → "snapshots/<sha>.tar.gz"

// Adapt your backend (R2 / S3 / fs / memory) to the 4-method BlobStore port:
const store: BlobStore = { head, put, get, delete: del };

// PUT — hash-verified, idempotent (re-PUT of identical content is a no-op):
const r = await putContentAddressed(store, {
  hash, scheme, readBody: () => req.arrayBuffer(), declaredLength, maxBytes: 100 * 1024 * 1024,
});

// GET — visibility-gated; returns the backend's native object for streaming:
const g = await getContentAddressed(store, { hash, scheme, isReferenced: (key) => refcount(key) > 0 });

// GC — delete the bytes once no live record references them:
await gcIfUnreferenced(store, key, async () => (await refcount(key)) > 0);
```

`BlobStore<TObject>` is generic over the backend's read object, so `get` hands
you back the real `R2ObjectBody` / `S3 stream` / fd to stream — the helpers own
the *policy* (hash-verify, dedupe, gate, refcount), the backend owns the *bytes*,
and HTTP framing + auth stay in your adapter.

## Layer B — artifact registry (the metadata + lifecycle)

`ArtifactRegistry` runs the listing lifecycle — publish (with dedupe), get, list,
unlist (with Layer-A blob GC), claim — over a `ListingStore` metadata backend,
with the *domain* (kinds, identity/trust, validation, dedupe key, claim
authorization) injected as policies.

```ts
const registry = new ArtifactRegistry(listingStore, {
  validate, findDuplicate, toInsert, idOf, isUnlisted, isClaimed,
  authorizeClaim, blobKeyOf, isBlobStillReferenced,
}, { blobStore });

await registry.publish(input);          // validate → dedupe → insert
await registry.unlist(id, actor);       // mark unlisted → GC the blob if now unreferenced
await registry.claim(id, claimant);     // gated by authorizeClaim
```

`memoryBlobStore()` is a ready in-memory `BlobStore` (reference backend + tests).

## Who wires it

The Papercusp "Cupboard" worker (`apps/operator-public`) is the first host: it
maps **R2 → `BlobStore`**, **D1 → `ListingStore`**, and **GitHub / channel-2 /
the harness·blueprint·snapshot·plugin kinds** onto the policy seam. Those
specifics stay in the adapter; this library names no consuming app.

Pure. No I/O of its own beyond what the injected backend does. No durability, no
retries, no rate-limiting — the host owns those.
