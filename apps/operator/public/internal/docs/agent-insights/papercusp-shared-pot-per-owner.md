# The dogfood papercusp pot is a PER-OWNER shared P2P pot (Solution C)
URL: /internal/docs/agent-insights/papercusp-shared-pot-per-owner

How a fresh install makes `papercusp` a P2P-shared pot that merges across the OWNER's own devices — per-owner identity in a private gist (never baked), an owner-signed allowlist policy as the admission gate, and the two bootstrap hook points. Gated by DOGFOOD_PAPERCUSP_POT_SHARE (default ON).

## What this is

On a packaged desktop install, the `papercusp` dogfood pot isn't just cloned
locally — it is set up as a **P2P-shared pot that merges data across the
OWNER's own devices**, with **no secret baked into the binary**. This is
"Solution C": a *per-owner* shared identity (a stranger who installs the app can
never join your pot), gated by `DOGFOOD_PAPERCUSP_POT_SHARE` (default **ON**;
the flag constant was renamed from `DOGFOOD_PAPERCUSP_HIVE_SHARE` in the
hive→pot terminology sweep — the underlying runtime flag string,
`papercusp-dogfood-papercusp-hive-share`, is unchanged).

## The two facts that shape the design

1. **A pot's Ed25519 keypair is its TOPIC + announce identity, not a writer
   key.** The substrate is "Model B" (per-device single-writer logs +
   read-merge — see `sync/hyperbee/peer-log.ts`), *not* Autobase. So sharing one
   keypair across devices is **safe** (no writer conflict): they just land on the
   same federation topic (`deriveHiveFederationTopic(pubkey)`) and read-merge as
   distinct writers.
2. **Discovery and data-merge are two SEPARATE gates.** The keypair gets devices
   onto the same topic (discovery). The actual **merge** is gated by
   **membership**: `classifySameHiveMember` (boot.ts) admits a remote device's
   log only if its `(github_user_id, device)` is in `hive_members`. A shared
   keypair grants discovery but **not** membership.

So Solution C has to solve BOTH: get the owner's devices onto one identity, AND
admit them to merge.

## How it works

### Identity — a per-owner PRIVATE gist (never baked)

`papercusp-shared-identity-gist.ts` stores the pot identity (Ed25519 private key
DER + the invite secret) in a **private GitHub gist** (`public:false`,
filename `papercusp-pot-identity.json`) tied to the owner's account. The first
device generates + publishes it; later devices `fetchOwnerHiveIdentity` and adopt
it. The private key is therefore protected by the owner's GitHub auth — the same
surface guarding their private repos — and is **not** in the app binary.

> The stricter "private key never leaves the creating device" posture is the
> remote-pot JOIN variant (share only the pubkey) — a heavier follow-up,
> deliberately not done.

### Admission — the owner-signed ALLOWLIST policy (no new security code)

The "auto-admit my own devices, refuse strangers" behavior is **the existing
audited policy gate**, not new code. `goSharedHive` calls `authorHivePolicy`
with `{ membership: 'allowlist', allowlist: [<owner github login>] }`. Then
`evaluateMembershipAdmission` (pot-membership-policy.ts) admits a joiner iff its
login is allowlisted. The `github_user_id`/login is authenticated via the device
attestation binding (can't be spoofed). **This is essential** — the default
`open` mode would admit any stranger on the topic.

### The two bootstrap hook points (`bootstrap-papercusp-pot.ts`)

`papercusp-pot-share.ts` exposes three flag-gated, best-effort, never-throwing
entry points wired around pot creation:

* **`adoptSharedHiveIdentity()`** — runs *before* create. If the owner already
  has an identity gist (a prior device made it), inject that keypair into the
  keychain so `ensurePapercuspHive` → `loadOrGenerateHiveKeypair` **loads** it
  (same pubkey ⇒ same topic) instead of minting a fresh per-device one.
* **`goSharedHive(state)`** — runs *after* create. First device publishes its
  just-minted keypair + a fresh invite secret to the gist; then BOTH paths
  announce on the **invite** topic (`setHiveListing` — not `public`, so no global
  directory / Cupboard leak) and author the allowlist policy.
* **`shareExistingHive()`** — the already-present / re-boot / "enable-later" path:
  publishes (first device) / announces / sets the policy on a pot that already
  exists, **skipping** if a gist holds an identity whose pubkey ≠ this pot's
  (a pre-existing mismatch can't be retroactively adopted).

The owner's GitHub login + token come from `resolveLocalGithubIdentity` (reads
the gh token); no gh auth ⇒ the whole thing no-ops and retries next boot.

## Security model (why C, not "bake one key")

* The private key is in the owner's **private gist**, never the public binary —
  strangers can't get it.
* A stranger who somehow lands on the topic is **refused by the allowlist**
  (only the owner's login is admitted). The membership gate is what protects the
  DATA; the topic merely needs the pubkey to discover.

## Gotchas / how to verify

* **Single-device smoke** (what's verifiable on one box): after the share step,
  `harness_shared.hive_policy` has the signed `{allowlist:[login],
  membership:'allowlist'}` row, and the `harness_registry` payload's
  `hiveDirectoryMeta.papercusp` has `visibility:'invite'` + an `inviteSecret`.
  If a restart keeps the **same** inviteSecret, the gist persisted (the gh token
  has the `gist` scope and the fetch/adopt round-trips).
* **2-device data-merge** can ONLY be witnessed with a real second device of the
  same GitHub login — it adopts the gist identity, gets auto-admitted by the
  allowlist, and federates. That's the part to check live.
* The flag is `DOGFOOD_PAPERCUSP_POT_SHARE` (default ON; see the rename note
  above). OFF ⇒ the share hooks
  are a pure no-op (local-only pot, byte-identical to pre-C).
