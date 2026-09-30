/**
 * Derive a deterministic 32-byte Hyperswarm topic from a harness's
 * canonical identity.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 + the
 * hyperswarm-replication wiring (this loop).
 *
 * v5 §0.2.7 + addendum 1 — canonical binding is by GitHub repository
 * id (so a renamed repo / fork doesn't shard the swarm). Pre-binding,
 * fall back to a workspace+slug deterministic key so single-engineer
 * dev still discovers itself in the swarm.
 *
 * The topic is `sha256("papercusp-substrate-v1:" + binding)`, where
 * `binding` is one of:
 *   - `gh:<repository_id>`              — verified shared harness
 *   - `local:<workspace_id>/<slug>`    — pre-binding / private dev
 *   - `hive:<hive_pubkey>`             — a shared HIVE, keyed by its Ed25519
 *                                        pubkey (shared-hive-federation P-003)
 *
 * The `hive:` binding is the federation key that REPLACES the shared-harness
 * slug as the top-level unit (D-001/D-003): a Hive's Swarms all join this one
 * topic and the Hive's harnesses' work-sync federates WITHIN it (harness sync
 * becomes a component, not the top unit — P-004). It reuses this same
 * `papercusp-substrate-v1:` namespace because it is the SAME Model-B substrate,
 * only re-keyed (D-003: change the key, not the transport). The pubkey is the
 * raw-32-byte base64 hive id; anyone who learns it (via the directory / an
 * invite) can derive the topic and join — the hash domain-separates without
 * hiding anything from a pubkey holder.
 *
 * 32 bytes is exactly Hyperswarm's expected topic length. The v1
 * prefix lets us rotate the entire swarm scheme later by bumping it
 * (e.g. when the protocol changes incompatibly).
 *
 * Pure: no I/O, no random, fully deterministic. Tests assert that
 * the same binding yields the same topic across runs.
 */

import { createHash } from 'node:crypto';

const TOPIC_PREFIX = 'papercusp-substrate-v1:';

export type SwarmBinding =
  | { kind: 'gh'; github_repository_id: number | string }
  | { kind: 'local'; workspace_id: string; harness_slug: string }
  | { kind: 'hive'; hive_pubkey: string }
  // The EXPLICIT, already-derived 32-byte topic (hex). A joiner learns a Hive's
  // topic from its invite/member link but NOT the Hive's pubkey — so it cannot
  // reconstruct a `hive:` binding and would otherwise re-derive a `gh:` topic
  // that DOESN'T match the owner's `hive:` topic (the join-vs-owner topic-split
  // bug: owner on hive:<pubkey>, joiner on gh:<repo_id> → incremental writes
  // never cross). This carrier lets the joiner federate on EXACTLY the link's
  // topic — the same one the owner is on.
  | { kind: 'topic'; topic_hex: string };

/**
 * WI-498 GAP 2 — which swarm-binding kinds carry a JOINER hive-home rebind, so the
 * receive-side admission resolves a hive-home projection slug for them. BOTH:
 *   - 'hive'  — the owner-discovered binding (carries the hive pubkey), AND
 *   - 'topic' — the DIRECT invite/link binding. The member link carries only the
 *               topic HASH, not the hive pubkey, so a direct join (no prior DHT
 *               directory discovery) cannot form a 'hive' binding (see the union
 *               above) and boots on a 'topic' binding instead.
 * A 'topic'-bound joiner that is a remote_hive member must STILL resolve its hive-home
 * projection (via joinerPotHomeSlug) so the OWNER's hive-home log announce (origin =
 * the owner's hive-home slug) is in-scope; otherwise onAnnounce buffers it as
 * scope_unresolved → grace-expires → rejects → federation never starts, even though
 * the peer is connected on the right topic (live-witnessed on the 2-machine rig). The
 * actual slug resolution stays self-gated by joinerPotHomeSlug (remote_hive view
 * only → else null → fail-open to today's member-slug binding), so a non-hive
 * 'topic'/'gh'/'local' harness is unaffected.
 */
export function bindingResolvesHiveHomeProjection(
  binding: SwarmBinding | null | undefined,
): boolean {
  return binding?.kind === 'hive' || binding?.kind === 'topic';
}

const TOPIC_HEX_RE = /^[0-9a-f]{64}$/i;

export function serializeBinding(b: SwarmBinding): string {
  if (b.kind === 'gh') {
    if (b.github_repository_id === '' || b.github_repository_id == null) {
      throw new Error('serializeBinding: gh binding requires non-empty github_repository_id');
    }
    return `gh:${String(b.github_repository_id)}`;
  }
  if (b.kind === 'hive') {
    if (!b.hive_pubkey) throw new Error('serializeBinding: hive binding requires hive_pubkey');
    return `hive:${b.hive_pubkey}`;
  }
  if (b.kind === 'topic') {
    if (!TOPIC_HEX_RE.test(b.topic_hex)) {
      throw new Error('serializeBinding: topic binding requires a 32-byte (64-hex) topic');
    }
    return `topic:${b.topic_hex.toLowerCase()}`;
  }
  if (!b.workspace_id) throw new Error('serializeBinding: local binding requires workspace_id');
  if (!b.harness_slug) throw new Error('serializeBinding: local binding requires harness_slug');
  // EI-1690: the `/` delimiter is not escaped, so a slashful workspace_id would make
  // `local:<ws>/<slug>` AMBIGUOUS — (ws:'a/x', slug:'y') and (ws:'a', slug:'x/y')
  // both serialize to `local:a/x/y`, so two distinct tenancy pairs could derive the
  // SAME swarm topic (cross-tenant federation onto one swarm — the topic IS the
  // tenancy boundary). A `/`-free workspace_id makes the FIRST `/` an unambiguous
  // separator (harness_slug is already `/`-free by its `^[a-z0-9][a-z0-9-]*$`
  // pattern). REJECT rather than escape/length-prefix: changing the serialization
  // would change the derived topic hash and break federation with already-connected
  // peers. Latent today (live ids are slug-like: 'default', 'papercusp-workspace'),
  // this closes the gap loudly instead of silently colliding.
  if (b.workspace_id.includes('/')) {
    throw new Error(
      `serializeBinding: local binding workspace_id must not contain "/" (swarm-topic delimiter ambiguity, EI-1690): ${b.workspace_id}`,
    );
  }
  return `local:${b.workspace_id}/${b.harness_slug}`;
}

export function deriveSwarmTopic(binding: SwarmBinding): Buffer {
  // An explicit topic IS the topic — use it verbatim (NOT hashed) so the joiner
  // lands on the owner's exact Hive topic from the link, not a re-derived one.
  if (binding.kind === 'topic') {
    if (!TOPIC_HEX_RE.test(binding.topic_hex)) {
      throw new Error('deriveSwarmTopic: topic binding requires a 32-byte (64-hex) topic');
    }
    return Buffer.from(binding.topic_hex, 'hex');
  }
  const key = TOPIC_PREFIX + serializeBinding(binding);
  return createHash('sha256').update(key, 'utf8').digest();
}

/**
 * The federation topic for a shared Hive, keyed by the Hive's Ed25519 pubkey
 * (shared-hive-federation-2026-06-08 P-003). Convenience wrapper over the
 * `hive:` binding — this is the per-Hive substrate topic that replaces the
 * shared-harness slug as the top-level federation key. `hivePubkeyBase64` is
 * the raw-32-byte base64 hive id from the Hive entity (hive-keypair.ts).
 */
export function deriveHiveFederationTopic(hivePubkeyBase64: string): Buffer {
  return deriveSwarmTopic({ kind: 'hive', hive_pubkey: hivePubkeyBase64 });
}

/** Diagnostic: hex-render the topic (good for logs + the substrate dashboard). */
export function topicAsHex(topic: Buffer): string {
  return topic.toString('hex');
}
