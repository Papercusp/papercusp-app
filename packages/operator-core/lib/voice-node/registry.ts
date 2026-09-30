/**
 * Voice-channel registry — the P-007 control plane's persistent half.
 *
 * One JSONB row per workspace (`operator_voice_channels`, migration 164), the
 * standard operator-state pattern. A channel maps a human name to the 32-byte
 * Hyperswarm topic peers rendezvous on. Live presence is NOT here — presence is
 * in-band on the peer connections (D-011); this is just the durable list.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readOperatorState, writeOperatorState } from '../operator-state-pg';

export interface VoiceChannel {
  id: string;
  name: string;
  topicHex: string;
  createdAt: number;
}

interface VoiceChannelsPayload {
  channels: VoiceChannel[];
}

const TABLE = 'operator_voice_channels' as const;

export async function listVoiceChannels(): Promise<VoiceChannel[]> {
  const payload = await readOperatorState<VoiceChannelsPayload>(TABLE);
  return payload?.channels ?? [];
}

export async function createVoiceChannel(name: string): Promise<VoiceChannel> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('voice: channel name required');
  const channels = await listVoiceChannels();
  const existing = channels.find((c) => c.name === trimmed);
  if (existing) return existing; // idempotent by name
  const channel: VoiceChannel = {
    id: `vc-${randomBytes(4).toString('hex')}`,
    name: trimmed,
    topicHex: randomBytes(32).toString('hex'),
    createdAt: Date.now(),
  };
  await writeOperatorState<VoiceChannelsPayload>(TABLE, { channels: [...channels, channel] });
  return channel;
}

export async function removeVoiceChannel(idOrName: string): Promise<boolean> {
  const channels = await listVoiceChannels();
  const next = channels.filter((c) => c.id !== idOrName && c.name !== idOrName);
  if (next.length === channels.length) return false;
  await writeOperatorState<VoiceChannelsPayload>(TABLE, { channels: next });
  return true;
}

/**
 * The deterministic 32-byte swarm topic for a shared harness's video channel
 * (plan holepunch-video-shared-harnesses-2026-06-05 D-003). Both peers MUST
 * derive the SAME topic without coordinating, so it is a pure hash of the shared
 * harness key — NOT a random per-peer value like a named channel. v1 keys on the
 * harness slug; when a globally-unique shared-harness id is available it should
 * key on that to avoid same-named-but-unrelated harness collisions.
 */
export function harnessVideoTopicHex(harness: string): string {
  return createHash('sha256').update(`papercusp-video-channel:${harness}`).digest('hex');
}

/**
 * Ensure (idempotently) a registry channel for a shared harness's video channel,
 * with the DETERMINISTIC topic above. Distinct from createVoiceChannel (random
 * topic, human-named) — a harness video channel must rendezvous on the same
 * topic across machines.
 */
export async function ensureVideoChannel(harness: string): Promise<VoiceChannel> {
  const slug = harness.trim();
  if (!slug) throw new Error('voice: harness required for video channel');
  const id = `vid-${slug}`;
  const channels = await listVoiceChannels();
  const existing = channels.find((c) => c.id === id);
  const topicHex = harnessVideoTopicHex(slug);
  if (existing) {
    // Heal a drifted topic to the deterministic one.
    if (existing.topicHex === topicHex) return existing;
    const healed = { ...existing, topicHex };
    await writeOperatorState<VoiceChannelsPayload>(TABLE, {
      channels: channels.map((c) => (c.id === id ? healed : c)),
    });
    return healed;
  }
  const channel: VoiceChannel = { id, name: `video:${slug}`, topicHex, createdAt: Date.now() };
  await writeOperatorState<VoiceChannelsPayload>(TABLE, { channels: [...channels, channel] });
  return channel;
}

export async function resolveVoiceChannel(idOrName: string): Promise<VoiceChannel | null> {
  const channels = await listVoiceChannels();
  return channels.find((c) => c.id === idOrName || c.name === idOrName) ?? null;
}
