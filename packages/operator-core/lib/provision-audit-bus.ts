/**
 * In-process per-(harness, plugin) provision audit bus.
 *
 * Producer: lib/provision/audit-log.ts `appendAudit()` publishes here
 * after the PG INSERT succeeds. Consumer: /api/provision/stream
 * subscribes via subscribe() so the UI sees events sub-millisecond
 * after they're recorded — no file polling, no fs.watch.
 *
 * Internals migrated to @papercusp/sse's getChannel (2026-05-11). Public
 * surface (publish/subscribe/AuditEnvelope) preserved verbatim.
 */
import { getChannel } from '@papercusp/sse';

export interface AuditEnvelope {
  channelKey: string;
  seq: number;
  entry: unknown;
  ts: number;
}

const CHANNEL_PREFIX = 'provision:';

function getAuditChannel(channelKey: string) {
  return getChannel<AuditEnvelope>(`${CHANNEL_PREFIX}${channelKey}`, { ringSize: 256 });
}

export function publish(channelKey: string, entry: unknown): AuditEnvelope {
  const ch = getAuditChannel(channelKey);
  const env: AuditEnvelope = { channelKey, seq: 0, entry, ts: Date.now() };
  const id = ch.publish(env);
  env.seq = id;
  return env;
}

export interface Subscription {
  recent: AuditEnvelope[];
  unsubscribe(): void;
}

export function subscribe(
  channelKey: string,
  onEntry: (env: AuditEnvelope) => void,
): Subscription {
  const ch = getAuditChannel(channelKey);
  const offPublish = ch.onPublish((item) => {
    try { onEntry(item.event); }
    catch { /* subscriber error doesn't tear down delivery */ }
  });

  return {
    recent: ch.recent.map((e) => e.event),
    unsubscribe() { offPublish(); },
  };
}
