'use client';

/**
 * Subscribes to /api/ui/intents/stream for this tab's client_id and
 * runs registered intent handlers as rows arrive.
 *
 * Lifecycle:
 *   1. On mount, register built-in intents + open EventSource.
 *   2. Each message is { id, intent, args } — look up handler in the
 *      registry, run it, POST back result or error.
 *   3. On unmount / page hide, close the source. Browser-managed
 *      auto-reconnect rebinds when the tab is visible again.
 *
 * The result/error round-trip is what unblocks the agent's
 * `ui:dispatch` long-poll on the server.
 */

import { useEffect } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import { reportSyncReachable, reportSyncUnreachable } from '@papercusp/sync';
import { getOrCreateClientId } from '@papercusp/operator-core/lib/ui/client-id';
import { lookupIntent } from '@papercusp/operator-core/lib/ui/intent-registry';
import { registerBuiltInIntents } from '@papercusp/operator-core/lib/ui/built-in-intents';
import {
  parseUiIntentMessage,
  type UiIntentMessage,
} from '@papercusp/operator-core/lib/cross-boundary-event-contracts';

async function executeIntent(msg: UiIntentMessage): Promise<void> {
  let result: unknown = null;
  let error: string | null = null;
  try {
    const entry = lookupIntent(msg.intent);
    if (!entry) {
      error = `unknown_intent: ${msg.intent}`;
    } else {
      result = await entry.handler(msg.args ?? {});
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    await fetch(`/api/ui/intents/${msg.id}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: result ?? null, error }),
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[ui-intent] failed to post result', msg.id, e);
  }
}

export function UiIntentDispatcher(): null {
  useEffect(() => {
    registerBuiltInIntents();
    const clientId = getOrCreateClientId();
    if (!clientId) return;

    const source = createResilientEventSource({
      url: `/api/ui/intents/stream?client_id=${encodeURIComponent(clientId)}`,
      // Always-on, app-wide stream (mounted once per tab) — feed the same
      // shared connectivity signal @papercusp/sync's own SSE transport
      // reports to, so a down operator surfaces as ONE consolidated
      // "operator connection lost" toast instead of silent reconnect churn.
      onOpen: () => reportSyncReachable(),
      onStatusChange: (status) => {
        if (status === 'failing') reportSyncUnreachable();
      },
      handlers: {
        message: (data) => {
          try {
            const msg = parseUiIntentMessage(JSON.parse(data));
            if (msg) void executeIntent(msg);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[ui-intent] bad message', e);
          }
        },
      },
    });
    return () => { source.close(); };
  }, []);
  return null;
}
