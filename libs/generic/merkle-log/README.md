# @papercusp/merkle-log

RFC 9162 section 2.1 Merkle trees: the tree hash (`rootHash`), inclusion proofs
(`inclusionProof` / `verifyInclusion`) and consistency proofs (`consistencyProof` /
`verifyConsistency`). The hashing is identical to RFC 6962 (SHA-256, `0x00` leaf
prefix, `0x01` node prefix); RFC 9162 adds the verification algorithms.

- Zero dependencies beyond `node:crypto`.
- Hashes are 64-character lowercase hex, so proofs are plain JSON.
- Leaf data is opaque bytes. Domain-tag your own leaf encoding before calling `leafHash`.
- The verifiers return `false` for any malformed input; they never throw.

Tested against the RFC 6962 reference tree (transparency-dev/merkle root hashes and
the Certificate Transparency inclusion/consistency vectors) plus an exhaustive sweep
of every leaf and every prefix up to 40 leaves.

Used by the Papercusp ledger anchor (agent-economy-flywheel P-041): every hour the
operator publishes the root of an append-only log of hash-chain links, and anyone can
prove an entry is covered by an anchored root.
