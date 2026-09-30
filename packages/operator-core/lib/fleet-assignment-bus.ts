/**
 * fleet_assignment observer — the machine-facing change-feed of the canonical
 * fleet-assignment state (state-not-chat-fleet-state-2026-06-05, D-003 / P-006).
 *
 * Migration 165 fires `NOTIFY fleet_assignment` on MEANINGFUL assignment-state
 * changes — presence intent/plan/files (NOT heartbeat-only bumps), plan-item
 * claim acquire/release/owner-change (NOT lease renewals), durable assignments,
 * and the work-item claim scalars (features.taken_by / issues.assignee) —
 * payload `"<workspace_id>::<source>::<agent_id>"`.
 *
 * This is the D-001/D-003 line made concrete: the TABLE WRITE is the record; a
 * machine that wants change-awareness subscribes HERE and re-queries the
 * `fleet_assignment` view (or `fleet:assignments`) — it does NOT derive state
 * from the coord message stream. The scoped lifecycle coord messages remain a
 * human-readable projection of the same writes, never the source.
 *
 * Mirrors `agent-activity-bus.ts` / `coord-inbox-bus.ts`: one dedicated LISTEN
 * connection, lazy start, max 1 connection on the embedded-PG admin URL.
 * Host-only — opens a long-lived PG connection, so only the Hono host imports
 * it (never a browser/Vite chunk).
 */
import postgres from "postgres";
import { longLivedPoolConnectionOptions } from "@papercusp/db-org";
import { getHarnessAdminUrl } from "./embedded-pg-discovery";
import { hubListen, listenHubEnabled } from "./pg-listen-hub";

export interface FleetAssignmentChange {
  workspaceId: string;
  /** Which representation changed: presence | plan_item_claim | plan_item_assignment | work_item_claim. */
  source: string;
  /** The agent whose assignment state changed (ownerId, or agent-name for assignments). */
  agentId: string;
}

/** A wake handler — invoked once per notification. The handler re-queries the
 *  view itself (the notification is a wake, not a payload of record). */
type Handler = (change: FleetAssignmentChange) => void;

const handlers = new Set<Handler>();
let started = false;
let listenerSql: postgres.Sql | null = null;
/** Hub unsubscribe (set only when PAPERCUSP_LISTEN_HUB=1 routes us onto the shared connection). */
let hubUnsub: (() => void) | null = null;

/** Register a wake handler; lazily starts the single LISTEN. Returns unsubscribe. */
export function onFleetAssignmentChange(handler: Handler): () => void {
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

/** Parse the NOTIFY payload "<workspace_id>::<source>::<agent_id>" (best-effort). */
export function parseFleetAssignmentPayload(
  payload: string | undefined,
): FleetAssignmentChange {
  const [workspaceId = "", source = "", ...rest] = (payload ?? "").split("::");
  return { workspaceId, source, agentId: rest.join("::") };
}

function fanout(change: FleetAssignmentChange): void {
  for (const h of handlers) {
    try {
      h(change);
    } catch (err) {
      console.error("[fleet-assignment-bus] handler threw:", err);
    }
  }
}

async function ensureStarted(): Promise<void> {
  if (started) return;
  started = true;
  try {
    const onNotify = (payload: string) => {
      if (handlers.size === 0) return;
      fanout(parseFleetAssignmentPayload(payload));
    };
    if (listenHubEnabled()) {
      hubUnsub = await hubListen("fleet_assignment", onNotify);
    } else {
      listenerSql = postgres(getHarnessAdminUrl(), {
        ...longLivedPoolConnectionOptions("fleet-assignment-bus"),
        max: 1,
        // LISTEN: idle by design — never reap for idleness (would drop the subscription).
        idle_timeout: 0,
      });
      await listenerSql.listen("fleet_assignment", onNotify);
    }
  } catch (err) {
    console.error("[fleet-assignment-bus] failed to start:", err);
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
