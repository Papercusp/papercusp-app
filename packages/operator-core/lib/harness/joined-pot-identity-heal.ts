/**
 * joined-pot-identity-heal — backfill the joined Pot's identity row
 * (`harness_shared.pots`) for a member that joined through an invite LINK that
 * carried no `hive_pubkey` (WI-10003559).
 *
 * THE GAP. `handleJoinLink` (join-link.ts) materializes the joined Pot's identity
 * row only when the link carries `hivePubkey`, and a link carries it only
 * alongside the owner-binding triple (url-scheme.ts). A bare link — e.g. the
 * `_create_from_repo` self-link fallback — carries only the swarm `topic`, so the
 * joiner never learns the pubkey at join time and nothing wrote the row later.
 * Without it the joiner can never run pot-git (git-sync-action's
 * `resolveHiveGitProtocolScope` refuses "stable hive identity unavailable" on
 * every tick) and every federated roster op fails `pot_members_pot_fkey`.
 * Measured on the rig VM, 2026-09-27: `hello-world-3-pot` had a git-sync routine
 * but no pots row, so the P-505 Phase A bare-store bootstrap could never run.
 *
 * WHY THIS IS SAFE WITHOUT TRUSTING ANY PEER. A pot's link topic is a
 * commitment to its pubkey: `topic = sha256('papercusp-substrate-v1:hive:' +
 * pubkey)` (`deriveSwarmTopic({ kind:'hive' })`). So a candidate pubkey from ANY
 * source — a peer's federated `pot-git:ref-announce` `hive_id`, a directory
 * descriptor — is accepted only when it re-derives the exact topic the joiner
 * recorded at join (`join-state.linkTopic`). A forger would need a sha256
 * second preimage. The candidate source is transport; the topic is the anchor.
 *
 * Posture: never throws. Every outcome is reported, so a member that has no
 * verifiable candidate yet reads as `no-verified-candidate`, not as silence.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { deriveSwarmTopic } from '../sync/hyperbee/derive-swarm-topic';

const TOPIC_HEX_RE = /^[0-9a-f]{64}$/i;

/** Fed-event key whose payload carries the signing hive's pubkey as `hive_id`
 *  (sync/pot-git/ref-announce.ts REF_ANNOUNCE_EVENT_KEY). Inlined so this module
 *  does not pull the pot-git graph into its importers. */
export const REF_ANNOUNCE_FED_EVENT_KEY = 'pot-git:ref-announce';

/**
 * The first candidate whose hive topic equals `linkTopicHex`, or null. Pure: a
 * malformed candidate (not a derivable pubkey) is skipped, never fatal.
 */
export function selectTopicVerifiedHivePubkey(
  linkTopicHex: string,
  candidates: Iterable<string | null | undefined>,
): string | null {
  if (!TOPIC_HEX_RE.test(linkTopicHex)) return null;
  const want = linkTopicHex.toLowerCase();
  for (const c of candidates) {
    if (typeof c !== 'string' || c.length === 0) continue;
    let derived: string;
    try {
      derived = deriveSwarmTopic({ kind: 'hive', hive_pubkey: c }).toString('hex');
    } catch {
      continue;
    }
    if (derived === want) return c;
  }
  return null;
}

export type JoinedPotIdentityHealOutcome =
  | { status: 'present' }
  | { status: 'healed'; pubkeyBase64: string }
  | { status: 'no-link-topic' }
  | { status: 'no-verified-candidate'; candidatesSeen: number }
  | { status: 'error'; reason: string };

export interface JoinedPotIdentityHealDeps {
  /** Does `harness_shared.pots` already hold a row for this home slug? */
  hasIdentity(workspaceId: string, homeSlug: string): Promise<boolean>;
  /** The link topic recorded at join for this slug (join-state.linkTopic), or null. */
  readLinkTopic(homeSlug: string): Promise<string | null>;
  /** Candidate hive pubkeys from local, already-received data. Unverified. */
  listCandidatePubkeys(workspaceId: string, homeSlug: string): Promise<string[]>;
  /** Write the NON-SIGNING remote identity row (hive-store upsertRemoteHiveIdentity). */
  upsertIdentity(input: {
    workspaceId: string;
    homeSlug: string;
    pubkeyBase64: string;
    keychainId: string;
  }): Promise<void>;
}

/**
 * Heal one pot home slug. Idempotent: an existing row short-circuits to
 * `present` before any candidate is read.
 */
export async function healJoinedPotIdentity(
  input: { workspaceId: string; homeSlug: string },
  deps: JoinedPotIdentityHealDeps = defaultJoinedPotIdentityHealDeps,
): Promise<JoinedPotIdentityHealOutcome> {
  const { workspaceId, homeSlug } = input;
  try {
    if (await deps.hasIdentity(workspaceId, homeSlug)) return { status: 'present' };
    const topic = await deps.readLinkTopic(homeSlug);
    if (!topic || !TOPIC_HEX_RE.test(topic)) return { status: 'no-link-topic' };
    const candidates = await deps.listCandidatePubkeys(workspaceId, homeSlug);
    const pubkey = selectTopicVerifiedHivePubkey(topic, candidates);
    if (!pubkey) return { status: 'no-verified-candidate', candidatesSeen: new Set(candidates).size };
    // Same non-signing placeholder shape as join-link.ts: a joiner never signs
    // for a Pot it does not own.
    await deps.upsertIdentity({ workspaceId, homeSlug, pubkeyBase64: pubkey, keychainId: `remote:${homeSlug}` });
    return { status: 'healed', pubkeyBase64: pubkey };
  } catch (e) {
    return { status: 'error', reason: e instanceof Error ? e.message : String(e) };
  }
}

// ── default deps (real PG + the on-disk join-state record) ──────────────────

async function defaultReadLinkTopic(homeSlug: string): Promise<string | null> {
  // join-shared-harness is the only writer of this record; its filename is the slug.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(homeSlug)) return null;
  try {
    const raw = await readFile(resolve(homedir(), '.papercusp', 'join-state', `${homeSlug}.json`), 'utf8');
    const js = JSON.parse(raw) as { slug?: unknown; linkTopic?: unknown };
    if (js?.slug !== homeSlug) return null;
    return typeof js.linkTopic === 'string' ? js.linkTopic : null;
  } catch {
    return null;
  }
}

async function defaultListCandidatePubkeys(workspaceId: string, homeSlug: string): Promise<string[]> {
  const out: string[] = [];
  // 1. Federated pot-git ref-announces for this harness: each signed payload names
  //    its hive as `hive_id`. Bounded by coord_event_log_fed_event_key_idx.
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = await sql<{ hive_id: string | null }[]>`
      SELECT body->'fed_event'->'payload'->>'hive_id' AS hive_id
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${homeSlug}
         AND surface = 'messages'
         AND body->'fed_event'->>'key' = ${REF_ANNOUNCE_FED_EVENT_KEY}
       ORDER BY id DESC
       LIMIT 50
    `;
    for (const r of rows) if (r.hive_id) out.push(r.hive_id);
  } catch {
    // unreadable log — fall through to the directory
  }
  // 2. The verified hive directory cache (announce-sourced descriptors).
  try {
    const { readOperatorState } = await import('../operator-state-pg');
    const cache = await readOperatorState<{ hives?: Array<{ hivePubkey?: unknown }> }>(
      'pot_directory_cache',
      workspaceId,
    );
    for (const h of cache?.hives ?? []) if (typeof h?.hivePubkey === 'string') out.push(h.hivePubkey);
  } catch {
    // unreadable cache — the event-log candidates stand alone
  }
  return out;
}

export const defaultJoinedPotIdentityHealDeps: JoinedPotIdentityHealDeps = {
  async hasIdentity(workspaceId, homeSlug) {
    const { getHiveBySlug } = await import('../hive-store');
    const hive = await getHiveBySlug(workspaceId, homeSlug);
    return Boolean(hive?.pubkeyBase64);
  },
  readLinkTopic: defaultReadLinkTopic,
  listCandidatePubkeys: defaultListCandidatePubkeys,
  async upsertIdentity(input) {
    const { upsertRemoteHiveIdentity } = await import('../hive-store');
    await upsertRemoteHiveIdentity(input);
  },
};
