/**
 * In-process per-(slug, runId) branch-action bus.
 *
 * Producer: lib/branch-actions.ts `runAction()` writeLine() publishes
 * each captured stdout/stderr chunk. Consumer:
 * /api/harness/<slug>/branch/<branch>/action-stream subscribes via
 * subscribe() — sub-millisecond fan-out, no 250ms polling.
 *
 * Internals migrated to @papercusp/sse's getChannel (2026-05-11). The
 * public surface (publish/subscribe/ActionEnvelope) is preserved so
 * call-sites don't need to change.
 */

import { getChannel } from '@papercusp/sse';

export type ActionEventKind = 'output' | 'stderr' | 'started' | 'completed' | 'failed';

export interface ActionEnvelope {
  channelKey: string;
  seq: number;
  kind: ActionEventKind;
  text: string;
  meta?: Record<string, unknown>;
  ts: number;
}

const CHANNEL_PREFIX = 'branch-action:';

function getActionChannel(channelKey: string) {
  return getChannel<ActionEnvelope>(`${CHANNEL_PREFIX}${channelKey}`, {
    ringSize: 256,
    gcDelayMs: 5 * 60_000, // matches prior behavior — 5 min after done + zero subs
  });
}

export function publish(
  channelKey: string,
  kind: ActionEventKind,
  text: string,
  meta?: Record<string, unknown>,
): ActionEnvelope {
  const ch = getActionChannel(channelKey);
  // Pre-build envelope so `seq` and `ts` match the published id and time.
  // We get back the assigned id from publish() and store it in `seq`.
  const env: ActionEnvelope = {
    channelKey,
    seq: 0, // placeholder; rewritten below
    kind,
    text,
    meta,
    ts: Date.now(),
  };
  // BusChannel.publish takes the event verbatim and returns the assigned id.
  // We patch env.seq with that id so subscribers see the correct monotonic seq.
  const id = ch.publish(env);
  env.seq = id;
  if (kind === 'completed' || kind === 'failed') {
    ch.done({ reason: kind });
  }
  return env;
}

export interface Subscription {
  recent: ActionEnvelope[];
  done: boolean;
  whenDone: Promise<void>;
  unsubscribe(): void;
}

export function subscribe(
  channelKey: string,
  onEvent: (env: ActionEnvelope) => void,
): Subscription {
  const ch = getActionChannel(channelKey);
  let resolveDone!: () => void;
  const whenDone = new Promise<void>((r) => { resolveDone = r; });
  const offPublish = ch.onPublish((item) => {
    try { onEvent(item.event); }
    catch { /* subscriber error doesn't tear down delivery */ }
  });
  const offDone = ch.onDone(() => resolveDone());

  return {
    recent: ch.recent.map((e) => e.event),
    done: ch.isDone,
    whenDone,
    unsubscribe() {
      offPublish();
      offDone();
      resolveDone();
    },
  };
}
