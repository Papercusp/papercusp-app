/**
 * In-process per-harness log-line bus.
 *
 * Producer: bash run.sh's log() function (and any other bash-side
 * logger) POSTs each line to /api/internal/log-event. The endpoint
 * calls publish() here. The operator's /:slug/log/stream and
 * /:slug/stream SSE handlers subscribe via subscribe().
 *
 * Channels:
 *   - "<slug>:log"  — structured JSONL events (run.log.jsonl)
 *   - "<slug>:raw"  — raw human-readable lines (run.log)
 *
 * Both surfaces are typically written together by the same log() call,
 * so both publish from a single POST.
 *
 * Internals migrated to @papercusp/sse's getChannel (2026-05-11). Public
 * surface (publish/subscribe/LogEnvelope) preserved verbatim.
 */
import { getChannel, _resetChannelsForTest } from '@papercusp/sse';

export interface LogEnvelope {
  channelKey: string;
  seq: number;
  line: string;
  ts: number;
}

const CHANNEL_PREFIX = 'harness-log:';

function getLogChannel(channelKey: string) {
  return getChannel<LogEnvelope>(`${CHANNEL_PREFIX}${channelKey}`, { ringSize: 256 });
}

/** Publish one log line to the channel. */
export function publish(channelKey: string, line: string): LogEnvelope {
  const ch = getLogChannel(channelKey);
  const env: LogEnvelope = { channelKey, seq: 0, line, ts: Date.now() };
  const id = ch.publish(env);
  env.seq = id;
  return env;
}

export interface Subscription {
  recent: LogEnvelope[];
  unsubscribe(): void;
}

/** Subscribe to a channel. Receives the recent ring buffer up front
 *  and live `line` events thereafter until unsubscribe. */
export function subscribe(
  channelKey: string,
  onLine: (env: LogEnvelope) => void,
): Subscription {
  const ch = getLogChannel(channelKey);
  const offPublish = ch.onPublish((item) => {
    try { onLine(item.event); }
    catch { /* subscriber error doesn't tear down delivery */ }
  });

  return {
    recent: ch.recent.map((e) => e.event),
    unsubscribe() { offPublish(); },
  };
}

/** Test-only: drop all channels. */
export function _resetForTest(): void {
  _resetChannelsForTest();
}
