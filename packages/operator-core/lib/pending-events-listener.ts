/**
 * pending_events observer.
 *
 * Per spec/workspace-scoping, concierge agents (Operator, Oracle, pi)
 * observe `pending_events` via LISTEN/NOTIFY — NEVER consume rows.
 * The orchestrator owns the queue's `consumed_at`/`consumed_by` columns.
 *
 * This listener subscribes once per operator process to
 * `pending_events_inserted`, parses the payload, and fans out to
 * registered handlers. Operator's auto-rescan and the top-bar icon-state
 * machine are wired via this fan-out.
 *
 * The trigger that fires NOTIFY lives in libs/db/sql/009-workspace-scoping.sql.
 */

import postgres from "postgres";
import { longLivedPoolConnectionOptions } from "@papercusp/db-org";
import { getHarnessAdminUrl } from "./embedded-pg-discovery";
import { hubListen, listenHubEnabled } from "./pg-listen-hub";

export interface PendingEventNotification {
  id: string;
  kind: string;
  target_role: string;
  workspace_id: string;
  due_at: string | null;
  created_at: string;
}

type Handler = (event: PendingEventNotification) => void;

const handlers = new Set<Handler>();
let started = false;
let listenerSql: postgres.Sql | null = null;
/** Hub unsubscribe (set only when PAPERCUSP_LISTEN_HUB=1 routes us onto the shared connection). */
let hubUnsub: (() => void) | null = null;

function adminUrl(): string {
  return getHarnessAdminUrl();
}

export function onPendingEventInserted(handler: Handler): () => void {
  handlers.add(handler);
  void ensureStarted();
  return () => {
    handlers.delete(handler);
    void maybeCloseListener();
  };
}

/** Close the listener if there are no handlers left (cleanup to avoid listener leak). */
async function maybeCloseListener(): Promise<void> {
  if (handlers.size === 0 && started) {
    if (hubUnsub) {
      hubUnsub();
      hubUnsub = null;
      started = false;
      return;
    }
    if (listenerSql) {
      try {
        await listenerSql.end({ timeout: 5 }).catch(() => {});
      } catch {
        // Ignore errors during close
      }
      listenerSql = null;
      started = false;
    }
  }
}

function onNotify(payload: string): void {
  try {
    const evt = JSON.parse(payload) as PendingEventNotification;
    for (const h of handlers) {
      try {
        h(evt);
      } catch (err) {
         
        console.error("[pending_events_listener] handler threw:", err);
      }
    }
  } catch (err) {
     
    console.error("[pending_events_listener] bad payload:", err);
  }
}

async function ensureStarted(): Promise<void> {
  if (started) return;
  started = true;
  try {
    if (listenHubEnabled()) {
      hubUnsub = await hubListen("pending_events_inserted", onNotify);
    } else {
      listenerSql = postgres(adminUrl(), {
        ...longLivedPoolConnectionOptions("pending-events-listener"),
        max: 1,
        // LISTEN: idle by design — never reap for idleness (would drop the subscription).
        idle_timeout: 0,
      });
      await listenerSql.listen("pending_events_inserted", onNotify);
    }
  } catch (err) {
     
    console.error("[pending_events_listener] failed to start:", err);
    started = false;
    listenerSql = null;
    hubUnsub = null;
  }
}

export async function _stopForTests(): Promise<void> {
  if (hubUnsub) {
    hubUnsub();
    hubUnsub = null;
  }
  if (listenerSql) {
    await listenerSql.end({ timeout: 5 }).catch(() => {});
  }
  listenerSql = null;
  started = false;
  handlers.clear();
}
